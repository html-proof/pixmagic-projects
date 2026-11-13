"use client";
import Link from "next/link";
import { useEffect, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ArrowUpRight, ChevronRight, CircleCheck } from "lucide-react";
import type { AlertView } from "@app/shared/alerts";
import type { Health } from "@app/shared/health";
import { HelpTip } from "@/components/PageKit";
import { fmtMoney, useApi } from "@/lib/api";
import { SIMPLE_HOME } from "@/lib/features";
import { HOME_LAYOUT_KEY, readLocal, writeLocal } from "@/lib/storage";
import { fmtDay, fmtLongDay, fmtSpan } from "./format";
import type { Need, NeedAction, NeedTone } from "./homeNeeds";
import { businessHealth } from "./Overview";
import type { Topic } from "./topics";
import type { Overview } from "./types";

// ---------------------------------------------------------------------------
// The simple Home (lib/features.ts SIMPLE_HOME), drawn as the owner's approved Stitch design draws
// it (prototype v2, screens 01, 03 and 04): what needs you, four numbers, sales by day and what
// changed, on plain white panels with a small radius and a
// faint shadow (globals.css `home-card`). Every figure is one the full dashboard shows too, worked
// out by the same code; the full dashboard stays one click away ("Show the full dashboard", kept
// per device).
// ---------------------------------------------------------------------------

export type HomeLayout = "simple" | "full";

/** Which Home this device shows: the simple one unless "Show the full dashboard" was chosen here. */
export function useHomeLayout(): [HomeLayout, (l: HomeLayout) => void] {
  const [saved, setSaved] = useState<HomeLayout | null>(null);
  // After mounting: the page is drawn before storage is read anywhere else, and the numbers load after this.
  useEffect(() => {
    const v = readLocal(HOME_LAYOUT_KEY);
    if (v === "simple" || v === "full") setSaved(v);
  }, []);
  const layout: HomeLayout = !SIMPLE_HOME ? "full" : (saved ?? "simple");
  return [
    layout,
    (l) => {
      writeLocal(HOME_LAYOUT_KEY, l);
      setSaved(l);
    },
  ];
}

/** "Good afternoon" by the clock of whoever is looking. */
export const greeting = (hour: number) => (hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");

/** A white panel and its heading, as the design draws each one. */
export function Panel({ id, title, className = "", children }: { id: string; title: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} data-testid={`home-${id}`} className={`home-card animate-rise flex min-w-0 flex-col p-5 sm:p-6 ${className}`}>
      <h2 id={`${id}-h`} className="home-h2">{title}</h2>
      <div className="mt-4 flex min-w-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

// ---- Needs you ----------------------------------------------------------------------------------

const DOT: Record<NeedTone, string> = { danger: "bg-fill-danger", warn: "bg-fill-warn", info: "bg-muted" };
const TONE_WORD: Record<NeedTone, string> = { danger: "Urgent", warn: "Soon", info: "When you can" };

function NeedButton({ a, onOpen }: { a: NeedAction; onOpen: (t: Topic) => void }) {
  if ("topic" in a) {
    return <button type="button" className="home-btn" onClick={() => onOpen(a.topic)}>{a.label}</button>;
  }
  return a.external ? (
    <a className="home-btn" href={a.href} target="_blank" rel="noopener noreferrer">
      {a.label}
      <ArrowUpRight aria-hidden className="h-4 w-4" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : (
    <Link className="home-btn" href={a.href}>{a.label}</Link>
  );
}

/** The few things to do now (`needsOf`), worst first, or that there are none. */
export function NeedsYou({ needs, onOpen }: { needs: Need[]; onOpen: (t: Topic) => void }) {
  return (
    <section aria-labelledby="needs-h" data-testid="home-needs" data-tour="needs" className="home-card animate-rise overflow-hidden">
      <h2 id="needs-h" className="home-h2 px-5 py-4 sm:px-6">Needs you</h2>
      {needs.length === 0 ? (
        <p className="flex items-center gap-2 px-5 pb-5 text-sm text-muted sm:px-6" data-testid="needs-none">
          <CircleCheck aria-hidden className="h-4 w-4 shrink-0 text-good" strokeWidth={2.25} />
          Nothing needs you right now.
        </p>
      ) : (
        <ul className="divide-y divide-home-line">
          {needs.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 py-3 transition-colors hover:bg-home-soft/60 sm:flex-nowrap sm:px-6" data-testid={`need-${n.id}`}>
              <span className="flex min-w-0 flex-1 items-start gap-3">
                <span aria-hidden className={`mt-[0.4rem] h-2 w-2 shrink-0 rounded-full ${DOT[n.tone]}`} />
                <span className="min-w-0 text-sm">
                  <span className="sr-only">{TONE_WORD[n.tone]}: </span>
                  {n.text}
                  {n.detail && <span className="mt-0.5 block text-xs leading-relaxed text-muted">{n.detail}</span>}
                </span>
              </span>
              {n.action && (
                <span className="ml-5 sm:ml-0">
                  <NeedButton a={n.action} onOpen={onOpen} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- The four numbers ---------------------------------------------------------------------------

/**
 * One of the four numbers: what it is, the figure, and a line under it (`sub`) when it has one.
 * The test id is the full dashboard's (`metric-<title>`), so a figure reads the same whichever
 * Home is shown. Opens its details.
 */
export function NumberTile({
  title,
  value,
  sub,
  extra,
  help,
  i = 0,
  onClick,
}: {
  title: string;
  value: ReactNode;
  sub?: ReactNode;
  extra?: ReactNode;
  /** What the figure measures, in plain words: behind the small "i" in the tile's corner (PageKit's HelpTip). */
  help?: ReactNode;
  i?: number;
  onClick: () => void;
}) {
  return (
    // The "i" sits over the tile's corner, beside it in the page: a button can't hold another.
    <div className="relative flex min-w-0">
      <button
        type="button"
        onClick={onClick}
        className="home-card animate-rise flex min-w-0 flex-1 flex-col p-4 text-left outline-none transition-shadow hover:shadow-[var(--shadow-lift)] focus-visible:ring-2 focus-visible:ring-accent sm:p-6"
        style={{ ["--i" as string]: i }}
        data-testid={`metric-${title}`}
      >
        <span className={`flex items-baseline justify-between gap-2 text-xs font-medium text-muted ${help ? "pr-6" : ""}`}>
          <span className="truncate">{title}</span>
        </span>
        <span className="mt-2 block truncate text-2xl leading-8 font-semibold tracking-[-0.02em] tabular-nums sm:mt-3 sm:text-[28px]">{value}</span>
        {sub !== undefined && <span className="mt-1 block min-w-0 text-xs text-muted">{sub}</span>}
        {extra && <span className="mt-1 block min-w-0 text-xs text-muted">{extra}</span>}
        <span className="sr-only"> – open details</span>
      </button>
      {help && (
        <HelpTip label={title} className="absolute top-3.5 right-3 sm:top-[22px] sm:right-5">
          {help}
        </HelpTip>
      )}
    </div>
  );
}

// ---- Sales by day -------------------------------------------------------------------------------

/** Up to five day labels under the bars: the first, the last, and a few evenly between (each week, on 30 days). */
export function tickDays(n: number): number[] {
  if (n <= 1) return n ? [0] : [];
  const step = Math.max(1, Math.round((n - 1) / 4));
  const out: number[] = [];
  for (let i = 0; i < n - 1; i += step) out.push(i);
  // The last day always; the one before it gives way when the two would touch.
  if (out.length > 1 && n - 1 - out[out.length - 1]! < step / 2) out.pop();
  out.push(n - 1);
  return out;
}

/**
 * The design's bars: a dark green column per day, today's paler with "today so far" over it. No
 * axis: the tooltip, the arrow keys and the table for screen readers give each day's figure.
 */
function DayBars({
  days,
  values,
  today,
  label,
  money,
}: {
  days: string[];
  values: number[];
  today: string;
  label: string;
  money: (n: number) => string;
}) {
  const n = days.length;
  const [hover, setAt] = useState<number | null>(null);
  // The dates can change under a held hover (a shorter range): never read past the new end.
  const at = hover !== null && hover < n ? hover : null;
  const top = Math.max(0, ...values) || 1;
  const pct = (v: number) => (Math.max(0, v) / top) * 100;
  const gap = n > 90 ? "gap-0" : n > 45 ? "gap-px" : "gap-1 sm:gap-1.5";
  const todayAt = days.indexOf(today);
  const name = (i: number) => `${fmtLongDay(days[i]!)}${i === todayAt ? " · today so far" : ""}`;
  const describe = (i: number) => `${name(i)}: ${label} ${money(values[i]!)}.`;
  // A label or tag over day i: from its column's left in the left half, from its right in the right half, so it never leaves the chart.
  const anchor = (i: number) => (i < n / 2 ? { left: `${(i / n) * 100}%` } : { right: `${((n - 1 - i) / n) * 100}%` });

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setAt(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - box.left) / box.width) * n))));
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setAt((i) => Math.max(0, Math.min(n - 1, (i ?? (step > 0 ? -1 : n)) + step)));
    } else if (e.key === "Escape") setAt(null);
  };

  return (
    <div className="min-w-0">
      <div
        className="relative rounded-md pt-7 outline-none select-none focus-visible:ring-2 focus-visible:ring-accent/60"
        role="figure"
        aria-label={`${label} by day. Use the left and right arrow keys to read each day.`}
        tabIndex={0}
        onKeyDown={keys}
        onBlur={() => setAt(null)}
      >
        <div className="relative h-44 touch-pan-y" onPointerMove={pick} onPointerLeave={() => setAt(null)} data-testid="day-bars">
          <div aria-hidden className={`grid h-full items-end border-b border-home-line ${gap}`} style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
            {values.map((v, i) => (
              <div key={days[i]} className="flex h-full items-end justify-center">
                <div
                  className={`animate-grow-y w-full max-w-12 rounded-t-[2px] bg-accent transition-opacity ${i === todayAt ? "opacity-35" : at !== null && at !== i ? "opacity-55" : ""}`}
                  style={{ height: `${pct(v)}%`, ["--i" as string]: Math.round((i * 24) / n) }}
                />
              </div>
            ))}
          </div>
          {todayAt >= 0 && at === null && (
            <span aria-hidden className="pointer-events-none absolute rounded bg-home-tag px-1 py-0.5 text-[11px] leading-none whitespace-nowrap" style={{ ...anchor(todayAt), bottom: `calc(${pct(values[todayAt]!)}% + 6px)` }}>
              today so far
            </span>
          )}
          {at !== null && (
            <div aria-hidden className="pointer-events-none absolute z-10 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap shadow-[var(--shadow)]" style={{ ...anchor(at), bottom: `calc(${pct(values[at]!)}% + 8px)` }}>
              <p className="font-medium">{name(at)}</p>
              <p className="mt-0.5 flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-[2px] bg-accent" />
                {label} <span className="font-semibold tabular-nums">{money(values[at]!)}</span>
              </p>
            </div>
          )}
        </div>
        <div aria-hidden className="relative mt-2 h-4 text-xs text-muted tabular-nums">
          {/* On a phone, as the design's phone Home: every other label, and no year. */}
          {tickDays(n).map((i, k) => (
            <span
              key={i}
              className={`absolute whitespace-nowrap ${k % 2 === 1 && i !== n - 1 ? "hidden sm:inline" : ""}`}
              style={i === 0 ? { left: 0 } : i === n - 1 ? { right: 0 } : { left: `${((i + 0.5) / n) * 100}%`, transform: "translateX(-50%)" }}
            >
              {n > 1 && (i === 0 || i === n - 1) ? (
                <>
                  <span className="sm:hidden">{fmtDay(days[i], { year: false })}</span>
                  <span className="hidden sm:inline">{fmtDay(days[i], { year: true })}</span>
                </>
              ) : (
                fmtDay(days[i], { year: false })
              )}
            </span>
          ))}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">{at !== null ? describe(at) : ""}</p>
      {/* The sr-only wrapper (not the table itself) keeps the table from widening the page. */}
      <div className="sr-only">
        <table>
          <caption>{label} by day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{label}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => (
              <tr key={d}>
                <th scope="row">{name(i)}</th>
                <td>{money(values[i]!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One chart: total sales (net sales for a member not shown tax and shipping) each day of the dates. */
export function SalesByDay({ ov, currency, className = "" }: { ov: Overview; currency: string; className?: string }) {
  const s = ov.modules.sales_overview!;
  const total = s.current.totalSales !== undefined;
  const pick = (d: { netSales: number; totalSales?: number }) => (total ? (d.totalSales ?? d.netSales) : d.netSales);
  const what = total ? "Total sales" : "Net sales";
  return (
    <section id="sales-by-day" aria-labelledby="sales-by-day-h" data-testid="home-sales-by-day" className={`home-card animate-rise flex min-w-0 flex-col p-5 sm:p-6 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="sales-by-day-h" className="home-h2">Sales by day</h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium">
          <span className="inline-flex items-center gap-1.5" title={`${what} each day`}>
            <span aria-hidden className="h-3 w-3 rounded-[2px] bg-accent" />
            {fmtSpan(ov.range.from, ov.range.to)}
          </span>
        </div>
      </div>
      <div className="mt-2 flex-1">
        <DayBars days={s.series.map((d) => d.day)} values={s.series.map(pick)} today={ov.today} label={what} money={(n) => fmtMoney(n, currency)} />
      </div>
    </section>
  );
}

// ---- What changed -------------------------------------------------------------------------------

const HEALTH_WORD: Record<Health, string> = { attention: "Needs attention", watch: "Keep an eye on", good: "Looking good", info: "For your info" };

/**
 * The business health check's first three (worst first, `businessHealth`), each opening its
 * details. `stacked`: beside the chart (the design's screen 03), "See why" goes under each line.
 */
export function WhatChanged({ ov, currency, onOpen, stacked = false }: { ov: Overview; currency: string; onOpen: (t: Topic) => void; stacked?: boolean }) {
  const checks = businessHealth(ov, currency).slice(0, 3);
  return (
    <Panel id="what-changed" title="What changed">
      {checks.length === 0 ? (
        <p className="text-sm text-muted">Nothing to point out yet: this fills in once orders come in.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {checks.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onOpen(c.topic)}
                className={`w-full rounded bg-home-soft p-3 text-left outline-none transition-colors hover:bg-home-soft-hover focus-visible:ring-2 focus-visible:ring-accent ${stacked ? "block" : "flex items-center justify-between gap-3"}`}
                data-testid={`insight-${c.id}`}
              >
                <span className={`min-w-0 text-sm leading-5 ${stacked ? "block font-medium" : "flex-1"}`}>
                  <span className="sr-only">{HEALTH_WORD[c.health]}: </span>
                  {c.area} · {c.text}
                </span>
                <span className={`shrink-0 text-[13px] font-medium whitespace-nowrap text-accent ${stacked ? "mt-2 flex items-center justify-end gap-0.5" : ""}`}>
                  See why
                  {stacked && <ChevronRight aria-hidden className="h-3.5 w-3.5" />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The bell's alerts for the Needs you list (`ws` null: not asked); null until they arrive, or if they can't be read. */
export function useHomeAlerts(ws: string | null): AlertView[] | null {
  const { data } = useApi<{ alerts: AlertView[] }>(ws ? `/workspaces/${ws}/alerts` : null);
  return data?.alerts ?? null;
}

"use client";
import Link from "next/link";
import { useEffect, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ArrowUpRight, ChevronRight, CircleCheck } from "lucide-react";
import type { AlertView } from "@app/shared/alerts";
import type { Health } from "@app/shared/health";
import { CHANNEL_NAME, useHub } from "@/components/automations/HubUi";
import { HelpTip } from "@/components/PageKit";
import type { HubAutomation, OverviewResponse } from "@/components/automations/types";
import { fmtMoney, fmtNum, fmtPct, useApi } from "@/lib/api";
import { HOME_AT_A_GLANCE, SIMPLE_HOME } from "@/lib/features";
import { needsSplit } from "@/lib/homeGlance";
import { HOME_LAYOUT_KEY, readLocal, writeLocal } from "@/lib/storage";
import { versusWords } from "./DateRange";
import { fmtDay, fmtLongDay, fmtSpan } from "./format";
import type { Need, NeedAction, NeedTone } from "./homeNeeds";
import { businessHealth } from "./Overview";
import type { Topic } from "./topics";
import type { Overview } from "./types";

// ---------------------------------------------------------------------------
// The simple Home (lib/features.ts SIMPLE_HOME), drawn as the owner's approved Stitch design draws
// it (prototype v2, screens 01, 03 and 04): what needs you, four numbers, sales by day, what
// changed, and the automations working for you, on plain white panels with a small radius and a
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
export function NeedsYou({ needs: every, onOpen }: { needs: Need[]; onOpen: (t: Topic) => void }) {
  // Three at most until asked for more (lib/homeGlance.ts): they arrive worst first, so what is urgent always shows.
  const [all, setAll] = useState(false);
  const { shown: needs, more } = needsSplit(every, all || !HOME_AT_A_GLANCE);
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
          {more > 0 && (
            <li className="px-5 py-2.5 sm:px-6">
              <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={() => setAll(true)} data-testid="needs-more">
                Show {more} more
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

// ---- The four numbers ---------------------------------------------------------------------------

/**
 * A change on the dates compared with, as the design writes it under a number: "+12.7%", green
 * when up, red when down. The date chip says what it is compared with, so the words "vs previous
 * 30 days" are for screen readers (and the tooltip names the dates).
 */
function Delta({ value, versus, compared }: { value: number | null | undefined; versus?: string; compared?: string }) {
  if (value === null || value === undefined) return <span title={compared}>No earlier data</span>;
  const tone = value > 0 ? "text-good" : value < 0 ? "text-danger" : "text-muted";
  return (
    <span className={`font-medium tabular-nums ${tone}`} title={compared}>
      <span className="sr-only">{value > 0 ? "up " : value < 0 ? "down " : "unchanged, "}</span>
      <span aria-hidden>{value > 0 ? "+" : value < 0 ? "−" : ""}</span>
      {fmtPct(Math.abs(value))}
      {versus && <span className="sr-only"> {versus}</span>}
    </span>
  );
}

/**
 * One of the four numbers: what it is, the figure, and its change on the dates compared with (or
 * `sub` in its place, for a figure with no earlier one). On a phone the change sits beside the
 * name, as the design's phone Home has it. The test id is the full dashboard's (`metric-<title>`),
 * so a figure reads the same whichever Home is shown. Opens its details.
 */
export function NumberTile({
  title,
  value,
  delta,
  versus,
  compared,
  sub,
  extra,
  help,
  i = 0,
  onClick,
}: {
  title: string;
  value: ReactNode;
  delta?: number | null;
  versus?: string;
  compared?: string;
  sub?: ReactNode;
  extra?: ReactNode;
  /** What the figure measures, in plain words: behind the small "i" in the tile's corner (PageKit's HelpTip). */
  help?: ReactNode;
  i?: number;
  onClick: () => void;
}) {
  const change = sub === undefined && <Delta value={delta} versus={versus} compared={compared} />;
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
          {change && <span className="shrink-0 sm:hidden">{change}</span>}
        </span>
        <span className="mt-2 block truncate text-2xl leading-8 font-semibold tracking-[-0.02em] tabular-nums sm:mt-3 sm:text-[28px]">{value}</span>
        {sub !== undefined ? <span className="mt-1 block min-w-0 text-xs text-muted">{sub}</span> : <span className="mt-1 hidden text-xs sm:block">{change}</span>}
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
 * The design's bars: a dark green column per day, today's paler with "today so far" over it, and
 * the dates compared with as a dotted line, day i over day i. No axis: the tooltip, the arrow keys
 * and the table for screen readers give each day's figures.
 */
function DayBars({
  days,
  values,
  before,
  today,
  label,
  beforeLabel,
  money,
}: {
  days: string[];
  values: number[];
  before: number[] | null;
  today: string;
  label: string;
  beforeLabel: string;
  money: (n: number) => string;
}) {
  const n = days.length;
  const [hover, setAt] = useState<number | null>(null);
  // The dates can change under a held hover (a shorter range): never read past the new end.
  const at = hover !== null && hover < n ? hover : null;
  const prev = before ? before.slice(0, n) : null;
  const top = Math.max(0, ...values, ...(prev ?? [])) || 1;
  const pct = (v: number) => (Math.max(0, v) / top) * 100;
  const gap = n > 90 ? "gap-0" : n > 45 ? "gap-px" : "gap-1 sm:gap-1.5";
  const line = prev && prev.length > 1 ? prev.map((v, i) => `${i ? "L" : "M"} ${i + 0.5} ${100 - pct(v)}`).join(" ") : null;
  const todayAt = days.indexOf(today);
  const name = (i: number) => `${fmtLongDay(days[i]!)}${i === todayAt ? " · today so far" : ""}`;
  const describe = (i: number) => `${name(i)}: ${label} ${money(values[i]!)}${prev?.[i] !== undefined ? `, ${beforeLabel} ${money(prev[i]!)}` : ""}.`;
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
          {line && (
            <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" data-testid="day-bars-before">
              <path d={line} fill="none" stroke="var(--home-prev)" strokeWidth={2} strokeDasharray="3 3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </svg>
          )}
          {todayAt >= 0 && at === null && (
            <span aria-hidden className="pointer-events-none absolute rounded bg-home-tag px-1 py-0.5 text-[11px] leading-none whitespace-nowrap" style={{ ...anchor(todayAt), bottom: `calc(${pct(values[todayAt]!)}% + 6px)` }}>
              today so far
            </span>
          )}
          {at !== null && (
            <div aria-hidden className="pointer-events-none absolute z-10 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap shadow-[var(--shadow)]" style={{ ...anchor(at), bottom: `calc(${Math.max(pct(values[at]!), prev?.[at] !== undefined ? pct(prev[at]!) : 0)}% + 8px)` }}>
              <p className="font-medium">{name(at)}</p>
              <p className="mt-0.5 flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-[2px] bg-accent" />
                {label} <span className="font-semibold tabular-nums">{money(values[at]!)}</span>
              </p>
              {prev?.[at] !== undefined && (
                <p className="mt-0.5 flex items-center gap-1.5 text-muted">
                  <span className="h-0.5 w-2.5 bg-home-prev" />
                  {beforeLabel} <span className="tabular-nums">{money(prev[at]!)}</span>
                </p>
              )}
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
              {prev && <th scope="col">{beforeLabel}</th>}
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => (
              <tr key={d}>
                <th scope="row">{name(i)}</th>
                <td>{money(values[i]!)}</td>
                {prev && <td>{prev[i] !== undefined ? money(prev[i]!) : "No data"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * One chart: total sales (net sales for a member not shown tax and shipping) each day of the dates,
 * with the dates compared with as a dotted line when they were imported (`previousSeries`).
 */
export function SalesByDay({ ov, currency, className = "" }: { ov: Overview; currency: string; className?: string }) {
  const s = ov.modules.sales_overview!;
  const total = s.current.totalSales !== undefined;
  const pick = (d: { netSales: number; totalSales?: number }) => (total ? (d.totalSales ?? d.netSales) : d.netSales);
  const what = total ? "Total sales" : "Net sales";
  const before = s.previousSeries?.map(pick) ?? null;
  // "Previous 30 days", "Same dates last year", "14 Mar 2026": the chip's comparison, as a name.
  const vs = versusWords(ov).replace(/^vs /, "");
  const beforeLabel = vs.charAt(0).toUpperCase() + vs.slice(1);
  return (
    <section id="sales-by-day" aria-labelledby="sales-by-day-h" data-testid="home-sales-by-day" className={`home-card animate-rise flex min-w-0 flex-col p-5 sm:p-6 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="sales-by-day-h" className="home-h2">Sales by day</h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium">
          <span className="inline-flex items-center gap-1.5" title={`${what} each day`}>
            <span aria-hidden className="h-3 w-3 rounded-[2px] bg-accent" />
            {fmtSpan(ov.range.from, ov.range.to)}
          </span>
          {before && (
            <span className="inline-flex items-center gap-1.5 text-muted">
              <span aria-hidden className="h-0.5 w-3 bg-muted" />
              {beforeLabel}
            </span>
          )}
        </div>
      </div>
      <div className="mt-2 flex-1">
        <DayBars days={s.series.map((d) => d.day)} values={s.series.map(pick)} before={before} today={ov.today} label={what} beforeLabel={beforeLabel} money={(n) => fmtMoney(n, currency)} />
      </div>
    </section>
  );
}

// ---- What changed -------------------------------------------------------------------------------

const HEALTH_WORD: Record<Health, string> = { attention: "Needs attention", watch: "Keep an eye on", good: "Looking good", info: "For your info" };

/**
 * The business health check's first three (worst first, `businessHealth`), each opening its
 * details. `stacked`: beside the chart (a store without automations, the design's screen 03),
 * "See why" goes under each line.
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

// ---- Working for you ----------------------------------------------------------------------------

/** Messages an automation handed to the provider in its last 30 days (test-only ones aren't sent). */
const sentOf = (a: HubAutomation) => a.last30Days.sent + a.last30Days.delivered + a.last30Days.undelivered;

const OFF_WORD: Partial<Record<HubAutomation["status"], string>> = { paused: "Paused", draft: "Off", pending_approval: "Waiting for approval", disabled: "Off" };

/**
 * The automations hub's own answer (GET .../automations, as /automations shows it), in the design's
 * words: "Order confirmation (SMS), On, 381 sent in 30 days", busiest first, and one that's off with
 * "Turn on". Turning one on asks to confirm, so that button opens the Automations page.
 */
export function WorkingForYou() {
  const { path } = useHub();
  const { data, error } = useApi<OverviewResponse>(path(""));
  const all = data?.automations ?? [];
  const on = all.filter((a) => a.status === "active").sort((a, b) => sentOf(b) - sentOf(a));
  const off = all.filter((a) => a.status !== "active");
  const shown = on.slice(0, 4);
  const offShown = shown.length < 4 ? off.slice(0, 1) : [];
  const canCreate = !!data && (data.permissions.manage.sms || data.permissions.manage.email);
  const row = "flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0";
  return (
    <Panel id="working" title="Working for you">
      {!data ? (
        error ? (
          <p className="text-sm text-muted">
            We couldn&apos;t load your automations.{" "}
            <Link href="/automations" className="font-medium text-accent hover:underline">Open Automations</Link>
          </p>
        ) : (
          <div className="space-y-2" aria-hidden>
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-10 rounded" />)}
          </div>
        )
      ) : shown.length === 0 && offShown.length === 0 ? (
        <div className="text-sm text-muted">
          <p>No automations yet. They can confirm orders, send shipping updates and remind shoppers who left at checkout.</p>
          <Link href={canCreate ? "/automations/new" : "/automations"} className="btn-primary mt-3 inline-flex h-8 items-center rounded px-3 text-[13px]">
            {canCreate ? "Set one up" : "Open Automations"}
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-home-line">
          {shown.map((a) => {
            const n = sentOf(a);
            return (
              <li key={`${a.channel}:${a.id}`} className={row} data-testid="working-on">
                <span className="min-w-0 text-sm">
                  {a.name} <span className="text-muted">({CHANNEL_NAME[a.channel]})</span>, On
                  {a.testMode ? " in test mode: messages are recorded, not sent" : `, ${n ? `${fmtNum(n)} sent in 30 days` : "nothing sent yet"}`}
                </span>
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-accent" />
              </li>
            );
          })}
          {offShown.map((a) => (
            <li key={`${a.channel}:${a.id}`} className={row} data-testid="working-off">
              <span className="min-w-0 text-sm">
                {a.name} <span className="text-muted">({CHANNEL_NAME[a.channel]})</span>, {OFF_WORD[a.status] ?? "Off"}
              </span>
              {a.status === "pending_approval" ? (
                <Link href="/automations" className="home-btn h-8">Review</Link>
              ) : (
                <Link href="/automations" className="btn-primary inline-flex h-8 shrink-0 items-center rounded px-3 text-[13px]">Turn on</Link>
              )}
            </li>
          ))}
          {on.length > shown.length && (
            <li className="pt-3 text-xs text-muted">
              and {fmtNum(on.length - shown.length)} more on ·{" "}
              <Link href="/automations" className="font-medium text-accent hover:underline">See all</Link>
            </li>
          )}
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

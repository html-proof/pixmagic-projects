"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { dailyBreakdown, weekdayOf, type BreakdownDay, type SalesDay, type SalesMonth, type YearBreakdown } from "@app/shared/sales";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { fmtDay, fmtLongDay, fmtMonth, fmtMoneyCompact, fmtMoneyWhole, fmtSpan, fmtWeekday } from "./format";
import { Delta } from "./primitives";

// ---------------------------------------------------------------------------
// The chart: columns over a running-total strip that shares their x positions.
//
// The running total gets its own strip and scale rather than a second y-axis on the columns:
// two scales on one plot line up arbitrarily, so the line's crossings would read as meaning
// something. Hovering (or arrowing through) a column reads out both at once.
// ---------------------------------------------------------------------------

export interface Column {
  key: string;
  value: number;
  fill: string;
  /** A period still running, or only partly imported: drawn lighter. */
  faded?: boolean;
  /** Not imported at all: a quiet band instead of a column. */
  missing?: boolean;
  /** Weekend days get a faint band behind them. */
  shaded?: boolean;
  running: number | null;
  tick: { top: string; bottom?: string; strong?: boolean; major?: boolean };
  /** Value written on the column's cap, when there's room for every one. */
  label?: string;
  /** Labelled even when the others can't be (best day, today). */
  keepLabel?: boolean;
  /** A short change readout above the label (month on month). */
  note?: { text: string; tone: "good" | "danger" };
}

const MARGIN = { left: 52, right: 10 };
const PLOT_H = 190;
const RUN_H = 64;
const FONT = 11;
/** Rough width of a label at 11px, for deciding what fits without measuring the DOM. */
const textWidth = (s: string) => s.length * 6.3 + 6;

/** Gridline steps a person would pick: 1, 2, 2.5 or 5 × a power of ten. */
export function niceTicks(max: number, count: number): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  // From a whole-number index, not a running sum: no drift, and sub-cent steps stay distinct.
  for (let i = 0; i * step < max + step * 0.999; i++) ticks.push(Number((i * step).toPrecision(12)));
  return ticks;
}

/** A column with a 4px rounded data end and a square foot on the baseline. */
function columnPath(x: number, w: number, y0: number, y1: number): string {
  const up = y1 <= y0;
  const h = Math.abs(y0 - y1);
  const r = Math.min(4, w / 2, h);
  if (up) {
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

export function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function ColumnsWithTotal({
  columns,
  label,
  fmtAxis,
  reference,
  runningLabel,
  fmtRunning,
  tooltip,
  describe,
  missingLabel,
}: {
  columns: Column[];
  /** What the chart shows, for assistive technology. */
  label: string;
  fmtAxis: (n: number) => string;
  /** A hairline across the plot (the average day). */
  reference?: number | null;
  runningLabel: string;
  fmtRunning: (n: number) => string;
  tooltip: (i: number) => ReactNode;
  describe: (i: number) => string;
  missingLabel: string;
}) {
  const [ref, width] = useWidth();
  const hatchId = `hatch-${useId().replace(/:/g, "")}`;
  const [active, setActive] = useState<number | null>(null);
  const n = columns.length;
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const slot = n ? plotW / n : 0;
  const barW = slot >= 6 ? Math.min(24, slot - 2) : Math.max(1, slot - 1);
  const cx = (i: number) => MARGIN.left + slot * (i + 0.5);

  // Labels on every cap only when each fits its slot; otherwise just the ones that matter.
  const labelled = columns.filter((c) => c.label && !c.missing);
  const allFit = labelled.every((c) => textWidth(c.label!) <= slot + 2);
  const showLabel = (c: Column) => !!c.label && !c.missing && (allFit || c.keepLabel);
  const showNotes = allFit && columns.some((c) => c.note);
  const top = showNotes ? 34 : columns.some(showLabel) ? 20 : 10;

  const values = columns.filter((c) => !c.missing).map((c) => c.value);
  const max = Math.max(0, ...values, reference ?? 0);
  const min = Math.min(0, ...values);
  const yTicks = niceTicks(max, 4);
  const yMax = yTicks.at(-1)! || 1;
  const yMin = min < 0 ? -niceTicks(-min, 1).at(-1)! : 0;
  const y = (v: number) => top + (1 - (v - yMin) / (yMax - yMin)) * PLOT_H;

  const allTicks = slot >= 26;
  const twoLineTicks = allTicks && columns.some((c) => c.tick.bottom);
  const tickH = twoLineTicks ? 30 : 18;
  const runTop = top + PLOT_H + tickH + 30;

  const runs = columns.map((c) => c.running);
  const runMax = Math.max(0, ...runs.filter((r): r is number => r !== null));
  const runMin = Math.min(0, ...runs.filter((r): r is number => r !== null));
  const runTicks = niceTicks(runMax, 3);
  const rMax = runTicks.at(-1)! || 1;
  const yr = (v: number) => runTop + (1 - (v - runMin) / (rMax - runMin)) * RUN_H;
  const height = runTop + RUN_H + 8;

  // The running total as line segments, broken across days that weren't imported.
  const segments: Array<Array<[number, number]>> = [];
  runs.forEach((r, i) => {
    if (r === null) return;
    const prev = i > 0 ? runs[i - 1] : null;
    if (prev === null || prev === undefined || !segments.length) segments.push([]);
    segments.at(-1)!.push([cx(i), yr(r)]);
  });
  const lastRun = runs.reduce<number | null>((a, r, i) => (r !== null ? i : a), null);

  // Contiguous stretches that weren't imported, drawn as one band each.
  const missingRuns: Array<[number, number]> = [];
  columns.forEach((c, i) => {
    if (!c.missing) return;
    const last = missingRuns.at(-1);
    if (last && last[1] === i - 1) last[1] = i;
    else missingRuns.push([i, i]);
  });

  // Ticks: every column when they fit, otherwise the major ones that don't collide.
  const ticks: number[] = [];
  let lastRight = -Infinity;
  columns.forEach((c, i) => {
    if (allTicks) return ticks.push(i);
    if (!c.tick.major) return;
    const w = textWidth(c.tick.top);
    if (cx(i) - w / 2 < lastRight + 4) return;
    ticks.push(i);
    lastRight = cx(i) + w / 2;
  });

  const indexAt = (clientX: number, rect: DOMRect) => {
    const i = Math.floor((clientX - rect.left - MARGIN.left) / slot);
    return i >= 0 && i < n ? i : null;
  };
  const onKey = (e: KeyboardEvent) => {
    const at = active ?? n - 1;
    const next = e.key === "ArrowLeft" ? at - 1 : e.key === "ArrowRight" ? at + 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (e.key === "Escape") return setActive(null);
    if (next === null) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(n - 1, next)));
  };

  const tipLeft = active === null ? 0 : cx(active);
  const tipAlign = tipLeft < 130 ? "translateX(-12px)" : tipLeft > width - 130 ? "translateX(calc(-100% + 12px))" : "translateX(-50%)";

  return (
    <div
      ref={ref}
      className="relative mt-4 select-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      tabIndex={0}
      role="group"
      aria-label={`${label}. Use the left and right arrow keys to read each column.`}
      onKeyDown={onKey}
      onFocus={() => setActive((a) => a ?? (n ? n - 1 : null))}
      onBlur={() => setActive(null)}
    >
      <p className="sr-only" aria-live="polite">{active !== null ? describe(active) : ""}</p>
      {width > 0 && n > 0 && (
        <svg
          width={width}
          height={height}
          className="block touch-pan-y"
          aria-hidden
          onPointerMove={(e) => setActive(indexAt(e.clientX, e.currentTarget.getBoundingClientRect()))}
          onPointerDown={(e) => setActive(indexAt(e.clientX, e.currentTarget.getBoundingClientRect()))}
          onPointerLeave={() => setActive(null)}
        >
          <defs>
            {/* Days that weren't imported: hatched, so they never pass for weekend bands or $0 days. */}
            <pattern id={hatchId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={6} height={6} fill="var(--border)" opacity={0.25} />
              <line x1={0} y1={0} x2={0} y2={6} stroke="var(--border)" strokeWidth={2} />
            </pattern>
          </defs>
          {/* Weekend bands, then the stretch nobody imported. */}
          {columns.map((c, i) =>
            c.shaded && !c.missing ? (
              <rect key={`w${c.key}`} x={MARGIN.left + slot * i} y={top} width={slot} height={PLOT_H} fill="var(--border)" opacity={0.35} />
            ) : null,
          )}
          {missingRuns.map(([a, b]) => {
            const x = MARGIN.left + slot * a;
            const w = slot * (b - a + 1);
            return (
              <g key={`m${a}`}>
                <rect x={x} y={top} width={w} height={PLOT_H} fill={`url(#${hatchId})`} />
                {w >= textWidth(missingLabel) + 8 && (
                  <>
                    <rect x={x + w / 2 - textWidth(missingLabel) / 2} y={top + 8} width={textWidth(missingLabel)} height={18} rx={4} fill="var(--surface)" />
                    <text x={x + w / 2} y={top + 21} textAnchor="middle" fontSize={FONT} fill="var(--muted)">{missingLabel}</text>
                  </>
                )}
              </g>
            );
          })}

          {/* Grid and axis: solid hairlines, labels in muted ink. */}
          {yTicks.map((t) => (
            <g key={`g${t}`}>
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} stroke="var(--border)" />
              <text x={MARGIN.left - 8} y={y(t) + 4} textAnchor="end" fontSize={FONT} fill="var(--muted)" className="tabular-nums">{fmtAxis(t)}</text>
            </g>
          ))}
          {yMin < 0 && <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(0)} y2={y(0)} stroke="var(--muted)" opacity={0.6} />}
          {reference != null && reference > 0 && (
            <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(reference)} y2={y(reference)} stroke="var(--text)" opacity={0.45} />
          )}

          {columns.map((c, i) => {
            if (c.missing) return null;
            const h = Math.abs(y(c.value) - y(0));
            const yTop = c.value === 0 ? y(0) : h < 2 ? y(0) - Math.sign(c.value) * 2 : y(c.value);
            const dim = active !== null && active !== i;
            return (
              <g key={c.key} opacity={dim ? 0.45 : 1} style={{ transition: "opacity 120ms" }}>
                {c.value !== 0 && <path d={columnPath(cx(i) - barW / 2, barW, y(0), yTop)} fill={c.fill} opacity={c.faded ? 0.45 : 1} />}
                {showLabel(c) && (
                  <text
                    x={Math.min(Math.max(cx(i), MARGIN.left + textWidth(c.label!) / 2), width - MARGIN.right - textWidth(c.label!) / 2)}
                    y={Math.min(yTop, y(0)) - 5}
                    textAnchor="middle"
                    fontSize={FONT}
                    fontWeight={c.keepLabel ? 600 : 500}
                    fill="var(--text)"
                    className="tabular-nums"
                  >
                    {c.label}
                  </text>
                )}
                {showNotes && c.note && (
                  <text x={cx(i)} y={Math.min(yTop, y(0)) - 19} textAnchor="middle" fontSize={FONT} fontWeight={600} fill={c.note.tone === "good" ? "var(--good)" : "var(--danger)"}>
                    {c.note.text}
                  </text>
                )}
              </g>
            );
          })}

          {ticks.map((i) => {
            const t = columns[i]!.tick;
            return (
              <g key={`t${i}`} fontSize={FONT} textAnchor="middle">
                <text x={cx(i)} y={top + PLOT_H + 14} fill={t.strong ? "var(--text)" : "var(--muted)"} fontWeight={t.strong ? 600 : 400}>{t.top}</text>
                {twoLineTicks && t.bottom && (
                  <text x={cx(i)} y={top + PLOT_H + 27} fill={t.strong ? "var(--text)" : "var(--muted)"} fontWeight={t.strong ? 600 : 400} fontSize={10}>{t.bottom}</text>
                )}
              </g>
            );
          })}

          {/* Running total strip. */}
          <text x={MARGIN.left} y={runTop - 8} fontSize={FONT} fill="var(--muted)">{runningLabel}</text>
          {runTicks.map((t) => (
            <g key={`r${t}`}>
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={yr(t)} y2={yr(t)} stroke="var(--border)" />
              <text x={MARGIN.left - 8} y={yr(t) + 4} textAnchor="end" fontSize={FONT} fill="var(--muted)" className="tabular-nums">{fmtAxis(t)}</text>
            </g>
          ))}
          {segments.map((pts, k) => {
            const line = pts.map(([px, py], j) => `${j ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
            const area = `${line}L${pts.at(-1)![0].toFixed(1)},${yr(Math.max(0, runMin)).toFixed(1)}L${pts[0]![0].toFixed(1)},${yr(Math.max(0, runMin)).toFixed(1)}Z`;
            return (
              <g key={`s${k}`}>
                <path d={area} fill="var(--viz-total)" opacity={0.1} />
                <path d={line} fill="none" stroke="var(--viz-total)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          {lastRun !== null && (
            <>
              <circle cx={cx(lastRun)} cy={yr(runs[lastRun]!)} r={4} fill="var(--viz-total)" stroke="var(--surface)" strokeWidth={2} />
              <text x={Math.min(cx(lastRun), width - MARGIN.right)} y={yr(runs[lastRun]!) - 9} textAnchor="end" fontSize={FONT} fontWeight={600} fill="var(--text)" className="tabular-nums">
                {fmtRunning(runs[lastRun]!)}
              </text>
            </>
          )}

          {active !== null && (
            <>
              <line x1={cx(active)} x2={cx(active)} y1={top} y2={runTop + RUN_H} stroke="var(--muted)" opacity={0.5} />
              {runs[active] !== null && (
                <circle cx={cx(active)} cy={yr(runs[active]!)} r={4} fill="var(--viz-total)" stroke="var(--surface)" strokeWidth={2} />
              )}
            </>
          )}
        </svg>
      )}
      {width === 0 && <div style={{ height: PLOT_H + RUN_H + 90 }} />}
      {active !== null && width > 0 && (
        <div
          className="pointer-events-none absolute z-10 min-w-40 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg"
          style={{ left: tipLeft, top: 0, transform: `${tipAlign} translateY(-100%)` }}
        >
          {tooltip(active)}
        </div>
      )}
    </div>
  );
}

/** A short colored key beside a legend label (identity is never color alone: the label says it). */
function Key({ kind, color, faded, children }: { kind: "box" | "line" | "band" | "hatch"; color: string; faded?: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {kind === "line" ? (
        <span aria-hidden className="inline-block h-0.5 w-4 rounded" style={{ background: color, opacity: 0.6 }} />
      ) : kind === "hatch" ? (
        <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: `repeating-linear-gradient(45deg, ${color} 0 1.5px, transparent 1.5px 4px)` }} />
      ) : (
        <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color, opacity: faded ? 0.45 : kind === "band" ? 0.6 : 1 }} />
      )}
      {children}
    </span>
  );
}

function Figure({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 truncate font-semibold">{value}</dd>
      {note && <dd className="truncate text-xs text-muted">{note}</dd>}
    </div>
  );
}

function TipRow({ children }: { children: ReactNode }) {
  return <div className="text-muted">{children}</div>;
}

const TIER_FILL = ["", "var(--viz-tier-1)", "var(--viz-tier-2)", "var(--viz-tier-3)"] as const;
/** Ungraded days (too few to set tiers) are one series: the ramp's middle step. */
const PLAIN_FILL = TIER_FILL[2];

/** "June complete", "July and August complete", "3 full months". */
function fullMonthsText(months: string[]): string | null {
  if (!months.length) return null;
  if (months.length > 2) return `${months.length} full months`;
  return `${months.map((m) => fmtMonth(m)).join(" and ")} complete`;
}

// ---------------------------------------------------------------------------
// Day by day, for the dates picked.
// ---------------------------------------------------------------------------

export function DailySalesCard({
  series,
  range,
  today,
  historyFrom,
  currency,
}: {
  series: SalesDay[];
  range: { from: string; to: string };
  today: string;
  historyFrom: string | null;
  currency: string;
}) {
  const [table, setTable] = useState(false);
  const b = dailyBreakdown(series, today, historyFrom);
  const money = (n: number) => fmtMoney(n, currency);
  const whole = (n: number) => fmtMoneyWhole(n, currency);
  const hasToday = b.days.some((d) => d.status === "today");
  const hasMissing = b.days.some((d) => d.status === "not_imported");
  const n = b.days.length;
  const t = b.tiers;
  const fillOf = (d: BreakdownDay) => (t ? TIER_FILL[d.tier] : PLAIN_FILL);

  const columns: Column[] = b.days.map((d) => {
    const weekend = weekdayOf(d.day) >= 5;
    return {
      key: d.day,
      value: d.netSales,
      fill: fillOf(d),
      faded: d.status === "today",
      missing: d.status === "not_imported",
      shaded: weekend,
      running: d.cumulative,
      tick: {
        top: n <= 31 ? String(Number(d.day.slice(8))) : fmtDay(d.day, { year: false }),
        bottom: d.status === "today" ? "Today" : fmtWeekday(d.day),
        strong: weekend || d.status === "today",
        // Long ranges label Mondays, very long ones the first of each month.
        major: n <= 31 || (n <= 120 ? weekdayOf(d.day) === 0 : d.day.endsWith("-01")),
      },
      label: d.netSales !== 0 ? whole(d.netSales) : undefined,
      keepLabel: d.day === b.best?.day || d.status === "today",
    };
  });

  const tip = (d: BreakdownDay) => {
    if (d.status === "not_imported") {
      return (
        <>
          <div className="font-medium">{fmtLongDay(d.day)}</div>
          <TipRow>Not imported: Shopify shared orders from {fmtDay(historyFrom)} on.</TipRow>
        </>
      );
    }
    const vsAvg = b.average && d.status === "complete" ? (d.netSales - b.average) / b.average : null;
    return (
      <>
        <div className="text-muted">{fmtLongDay(d.day)}{d.status === "today" ? " · today so far" : ""}</div>
        <div className="mt-0.5 text-sm font-semibold tabular-nums">{money(d.netSales)}</div>
        <TipRow>{d.orders === 1 ? "1 order" : `${fmtNum(d.orders)} orders`}{d.averageOrderValue !== null ? ` · ${money(d.averageOrderValue)} average` : ""}</TipRow>
        {d.refunds > 0 && <TipRow>Refunds {money(d.refunds)}</TipRow>}
        {vsAvg !== null && <TipRow>{vsAvg >= 0 ? "▲" : "▼"} {fmtPct(Math.abs(vsAvg))} {vsAvg >= 0 ? "above" : "below"} an average day</TipRow>}
        {d.cumulative !== null && (
          <div className="mt-1 flex items-center gap-1.5 text-muted">
            <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: "var(--viz-total)" }} />
            <span className="font-medium tabular-nums text-text">{money(d.cumulative)}</span> so far
          </div>
        )}
      </>
    );
  };
  const describe = (i: number) => {
    const d = b.days[i]!;
    if (d.status === "not_imported") return `${fmtLongDay(d.day)}: not imported.`;
    return `${fmtLongDay(d.day)}${d.status === "today" ? ", today so far" : ""}: ${money(d.netSales)} net sales from ${fmtNum(d.orders)} orders. ${money(d.cumulative ?? 0)} so far in this range.`;
  };

  const notes = [
    fullMonthsText(b.fullMonths),
    hasToday ? `${fmtDay(today, { year: false })} is today (so far)` : null,
    hasMissing ? `orders before ${fmtDay(historyFrom, { year: false })} weren't shared by Shopify` : null,
  ].filter(Boolean);

  return (
    <div className="card animate-rise mt-4 min-w-0" style={{ ["--i" as string]: 4 }} data-testid="daily-sales">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{fmtSpan(range.from, range.to)} · Daily</p>
          <p className="mt-1 text-3xl font-semibold">{money(b.total)}</p>
          {notes.length > 0 && <p className="mt-0.5 text-xs text-muted first-letter:uppercase">{notes.join(" · ")}</p>}
        </div>
        <button className="text-xs text-muted underline" onClick={() => setTable((x) => !x)}>{table ? "Show chart" : "Show table"}</button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Figure label="Average day" value={b.average !== null ? money(b.average) : "—"} note={hasToday ? "finished days only" : `${fmtNum(b.importedDays)} days`} />
        <Figure label="Best day" value={b.best ? money(b.best.netSales) : "—"} note={b.best ? fmtLongDay(b.best.day) : "no sales yet"} />
        <Figure label="Days with sales" value={`${fmtNum(b.daysWithSales)} of ${fmtNum(b.importedDays)}`} note={b.importedDays ? `${fmtPct(b.daysWithSales / b.importedDays)} of days` : undefined} />
        {b.bestWeekday ? (
          <Figure
            label="Best weekday"
            value={new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 5 + b.bestWeekday.weekday)))}
            note={`${money(b.bestWeekday.average)} on average`}
          />
        ) : (
          <Figure label="Orders" value={fmtNum(b.orders)} note={b.orders ? `${money(Math.round((b.total / b.orders) * 100) / 100)} net per order` : undefined} />
        )}
      </dl>

      {table ? (
        <div className="mt-4 max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Net sales per day</caption>
            <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
              <tr>
                <th className="py-1 font-normal">Day</th>
                <th className="py-1 text-right font-normal">Net sales</th>
                <th className="py-1 text-right font-normal">Orders</th>
                <th className="py-1 text-right font-normal">Average order</th>
                <th className="py-1 text-right font-normal">Refunds</th>
                <th className="py-1 text-right font-normal">So far</th>
              </tr>
            </thead>
            <tbody>
              {b.days.map((d) => (
                <tr key={d.day} className="border-t border-border">
                  <td className="py-1">{fmtLongDay(d.day)}{d.status === "today" ? " (so far)" : ""}</td>
                  {d.status === "not_imported" ? (
                    <td colSpan={5} className="py-1 text-right text-muted">Not imported</td>
                  ) : (
                    <>
                      <td className="py-1 text-right tabular-nums">{money(d.netSales)}</td>
                      <td className="py-1 text-right tabular-nums">{fmtNum(d.orders)}</td>
                      <td className="py-1 text-right tabular-nums">{d.averageOrderValue !== null ? money(d.averageOrderValue) : "—"}</td>
                      <td className="py-1 text-right tabular-nums">{d.refunds ? money(d.refunds) : "—"}</td>
                      <td className="py-1 text-right tabular-nums">{money(d.cumulative ?? 0)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {t ? (
              <>
                {t.best !== null && <Key kind="box" color={TIER_FILL[3]}>≥ {whole(t.best)}</Key>}
                <Key kind="box" color={TIER_FILL[2]}>{t.best !== null ? `${whole(t.strong)} – ${whole(t.best)}` : `≥ ${whole(t.strong)}`}</Key>
                <Key kind="box" color={TIER_FILL[1]}>Under {whole(t.strong)}</Key>
              </>
            ) : null}
            {hasToday && <Key kind="box" color={t ? TIER_FILL[1] : PLAIN_FILL} faded>Today (so far)</Key>}
            {b.average !== null && b.average > 0 && <Key kind="line" color="var(--text)">Average day {whole(b.average)}</Key>}
            <Key kind="band" color="var(--border)">Weekend</Key>
            {hasMissing && <Key kind="hatch" color="var(--muted)">Not imported</Key>}
          </div>
          <ColumnsWithTotal
            columns={columns}
            label={`Net sales per day, ${fmtSpan(range.from, range.to)}, with the running total below`}
            fmtAxis={(v) => fmtMoneyCompact(v, currency)}
            reference={b.average}
            runningLabel="Running total"
            fmtRunning={whole}
            tooltip={(i) => tip(b.days[i]!)}
            describe={describe}
            missingLabel="Not imported"
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month by month, for this calendar year.
// ---------------------------------------------------------------------------

export function MonthlySalesCard({ year, historyFrom, currency }: { year: YearBreakdown; historyFrom: string | null; currency: string }) {
  const [table, setTable] = useState(false);
  const money = (n: number) => fmtMoney(n, currency);
  const whole = (n: number) => fmtMoneyWhole(n, currency);
  const months = year.months;
  const current = months.at(-1);

  let running = 0;
  const cumulative = months.map((m) => (m.coverage === "none" ? null : (running = Math.round((running + m.netSales) * 100) / 100)));
  const finished = months.filter((m) => !m.current && m.coverage === "full");
  const average = finished.length ? finished.reduce((a, m) => a + m.netSales, 0) / finished.length : null;
  const best = months.filter((m) => m.coverage !== "none" && m.netSales > 0).reduce<SalesMonth | null>((a, m) => (!a || m.netSales > a.netSales ? m : a), null);
  const firstImported = months.find((m) => m.coverage !== "none");
  const anyMissing = months.some((m) => m.coverage !== "full");

  const changeText = (c: number) => `${c >= 0 ? "▲" : "▼"} ${fmtPct(Math.abs(c))}`;
  const columns: Column[] = months.map((m, i) => ({
    key: m.month,
    value: m.netSales,
    fill: "var(--viz-tier-2)",
    faded: m.current || m.coverage === "partial",
    missing: m.coverage === "none",
    running: cumulative[i]!,
    tick: { top: fmtMonth(m.month, { short: true }), bottom: m.current ? "so far" : m.coverage === "partial" ? "partial" : undefined, strong: m.current, major: true },
    label: whole(m.netSales),
    keepLabel: m.current || m.month === best?.month,
    note: m.change !== null && !m.current ? { text: changeText(m.change), tone: m.change >= 0 ? "good" : "danger" } : undefined,
  }));

  const comparedText = (m: SalesMonth) =>
    !m.comparedWith ? null : m.current ? `vs ${fmtSpan(m.comparedWith.from, m.comparedWith.to)}` : `vs ${fmtMonth(m.comparedWith.from.slice(0, 7))}`;
  const tip = (i: number) => {
    const m = months[i]!;
    if (m.coverage === "none") {
      return (
        <>
          <div className="font-medium">{fmtMonth(m.month, { year: true })}</div>
          <TipRow>Not imported: Shopify shared orders from {fmtDay(historyFrom)} on.</TipRow>
        </>
      );
    }
    return (
      <>
        <div className="text-muted">{fmtMonth(m.month, { year: true })}{m.current ? ` · to ${fmtDay(m.to, { year: false })}` : ""}</div>
        <div className="mt-0.5 text-sm font-semibold tabular-nums">{money(m.netSales)}</div>
        <TipRow>{m.orders === 1 ? "1 order" : `${fmtNum(m.orders)} orders`}{m.averageOrderValue !== null ? ` · ${money(m.averageOrderValue)} average` : ""}</TipRow>
        {m.refunds > 0 && <TipRow>Refunds {money(m.refunds)}</TipRow>}
        {m.change !== null && <TipRow>{changeText(m.change)} {comparedText(m)}</TipRow>}
        {m.coverage === "partial" && <TipRow>Only from {fmtDay(historyFrom, { year: false })}: earlier orders weren&apos;t shared by Shopify.</TipRow>}
        <div className="mt-1 flex items-center gap-1.5 text-muted">
          <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: "var(--viz-total)" }} />
          <span className="font-medium tabular-nums text-text">{money(cumulative[i] ?? 0)}</span> this year so far
        </div>
      </>
    );
  };
  const describe = (i: number) => {
    const m = months[i]!;
    if (m.coverage === "none") return `${fmtMonth(m.month, { year: true })}: not imported.`;
    return `${fmtMonth(m.month, { year: true })}${m.current ? " so far" : ""}: ${money(m.netSales)} net sales from ${fmtNum(m.orders)} orders${m.change !== null ? `, ${m.change >= 0 ? "up" : "down"} ${fmtPct(Math.abs(m.change))} ${comparedText(m)}` : ""}.`;
  };

  return (
    <div className="card animate-rise mt-4 min-w-0" style={{ ["--i" as string]: 5 }} data-testid="monthly-sales">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">This year · Monthly</p>
          <p className="mt-1 text-3xl font-semibold">{money(year.total)}</p>
          <p className="mt-0.5 text-xs text-muted">
            {fmtSpan(`${year.year}-01-01`, current?.to ?? `${year.year}-01-01`)}
            {current ? ` · ${fmtMonth(current.month)} is month to date` : ""}
            {anyMissing && firstImported ? ` · orders before ${fmtDay(historyFrom, { year: false })} weren't shared by Shopify` : ""}
          </p>
        </div>
        <button className="text-xs text-muted underline" onClick={() => setTable((x) => !x)}>{table ? "Show chart" : "Show table"}</button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Figure label="Average month" value={average !== null ? money(average) : "—"} note={finished.length ? `over ${finished.length} full month${finished.length === 1 ? "" : "s"}` : "no full month yet"} />
        <Figure label="Best month" value={best ? money(best.netSales) : "—"} note={best ? fmtMonth(best.month) : "no sales yet"} />
        <Figure label="Orders this year" value={fmtNum(year.orders)} note={year.orders ? `${money(Math.round((year.total / year.orders) * 100) / 100)} net per order` : undefined} />
        {current && (
          <Figure
            label={`${fmtMonth(current.month)} so far`}
            value={money(current.netSales)}
            note={current.change !== null ? <Delta value={current.change} label={comparedText(current)!} /> : "nothing comparable before it"}
          />
        )}
      </dl>

      {table ? (
        <div className="mt-4 overflow-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Net sales per month this year</caption>
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1 font-normal">Month</th>
                <th className="py-1 text-right font-normal">Net sales</th>
                <th className="py-1 text-right font-normal">Orders</th>
                <th className="py-1 text-right font-normal">Average order</th>
                <th className="py-1 text-right font-normal">Change</th>
                <th className="py-1 text-right font-normal">Year so far</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m, i) => (
                <tr key={m.month} className="border-t border-border">
                  <td className="py-1">{fmtMonth(m.month)}{m.current ? " (so far)" : m.coverage === "partial" ? " (partly imported)" : ""}</td>
                  {m.coverage === "none" ? (
                    <td colSpan={5} className="py-1 text-right text-muted">Not imported</td>
                  ) : (
                    <>
                      <td className="py-1 text-right tabular-nums">{money(m.netSales)}</td>
                      <td className="py-1 text-right tabular-nums">{fmtNum(m.orders)}</td>
                      <td className="py-1 text-right tabular-nums">{m.averageOrderValue !== null ? money(m.averageOrderValue) : "—"}</td>
                      <td className="py-1 text-right tabular-nums">{m.change !== null ? `${changeText(m.change)} ${comparedText(m)}` : "—"}</td>
                      <td className="py-1 text-right tabular-nums">{money(cumulative[i] ?? 0)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <Key kind="box" color="var(--viz-tier-2)">Net sales</Key>
            {current && <Key kind="box" color="var(--viz-tier-2)" faded>Month so far{anyMissing ? " / partly imported" : ""}</Key>}
            {months.some((m) => m.coverage === "none") && <Key kind="hatch" color="var(--muted)">Not imported</Key>}
            <span>▲▼ change on the month before</span>
          </div>
          <ColumnsWithTotal
            columns={columns}
            label={`Net sales per month in ${year.year}, with the year's running total below`}
            fmtAxis={(v) => fmtMoneyCompact(v, currency)}
            runningLabel="Year so far"
            fmtRunning={whole}
            tooltip={tip}
            describe={describe}
            missingLabel="Not imported"
          />
        </>
      )}
    </div>
  );
}

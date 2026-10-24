"use client";
/**
 * The overview's sales chart, as the owner's design draws it: columns (one a day, or one a year side
 * by side for each month), each with its figure on a pill above it, and the running total as a
 * line over them, read off its own scale on the right in the line's colour. The right-hand labels
 * sit on the left's gridlines, so the two scales share every line. Hovering (or arrowing through) a
 * column reads out everything at once. The sales details keep ColumnsWithTotal, whose running total
 * has a strip of its own.
 */
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { columnPath, niceStep, niceTicks, useWidth } from "./chartUtils";

export interface ComboBar {
  /** Null: not imported, so no column at all (never a 0). */
  value: number | null;
  fill: string;
  /** Written above the column, on a pill, when every label fits (or the group's `keepLabel`). */
  label?: string;
  /** The label in muted ink: a period still running. */
  quiet?: boolean;
  /** A short change above the label (month on month), green or red, with its sign. */
  note?: { text: string; tone: "good" | "danger" };
  /** Under the group's tick, below this column: which year it is. */
  sub?: string;
}

export interface ComboGroup {
  key: string;
  bars: ComboBar[];
  /** The running total to the end of this group; null where there is none (not imported). */
  running: number | null;
  /** The date or month, and the weekday under it (weekends in orange). */
  tick: { top: string; bottom?: string; strong?: boolean; weekend?: boolean; major?: boolean };
  /** Labelled even when the others can't be (the best day, today). */
  keepLabel?: boolean;
}

/** Room for the axis labels either side; less of it on a phone. */
const marginsFor = (width: number) => (width < 480 ? { left: 46, right: 46 } : { left: 56, right: 56 });
const BAR_MAX = 28;
/** Between the columns of one group. */
const GAP = 1;
const LABEL_FONT = 9;
const AXIS_FONT = 10;
/** Rough widths at those sizes, to decide what fits without measuring the DOM. */
const pillWidth = (s: string) => Math.max(s.length * 5.2 + 6, 24);
const tickWidth = (s: string) => s.length * 5.9 + 6;

/**
 * A smooth line through the points that never overshoots them (monotone in x, as d3's
 * curveMonotoneX): a running total that only rises is never drawn dipping between two days.
 */
function monotonePath(pts: Array<[number, number]>): string {
  const n = pts.length;
  if (!n) return "";
  const f = (v: number) => v.toFixed(1);
  if (n < 3) return pts.map(([x, y], i) => `${i ? "L" : "M"}${f(x)},${f(y)}`).join("");
  const slope = (i: number) => (pts[i + 1]![1] - pts[i]![1]) / (pts[i + 1]![0] - pts[i]![0] || 1);
  const t: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    const [s0, s1] = [slope(i - 1), slope(i)];
    const [h0, h1] = [pts[i]![0] - pts[i - 1]![0], pts[i + 1]![0] - pts[i]![0]];
    const p = (s0 * h1 + s1 * h0) / (h0 + h1 || 1);
    t[i] = (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  t[0] = (3 * slope(0) - t[1]!) / 2;
  t[n - 1] = (3 * slope(n - 2) - t[n - 2]!) / 2;
  let d = `M${f(pts[0]![0])},${f(pts[0]![1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const dx = (x1 - x0) / 3;
    d += `C${f(x0 + dx)},${f(y0 + dx * t[i]!)} ${f(x1 - dx)},${f(y1 - dx * t[i + 1]!)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

function Pill({ x, y, text, fill, weight = 600 }: { x: number; y: number; text: string; fill: string; weight?: number }) {
  const w = pillWidth(text);
  return (
    <g>
      <rect x={x - w / 2} y={y - 10} width={w} height={13} rx={2} fill="var(--surface)" fillOpacity={0.93} />
      <text x={x} y={y} textAnchor="middle" fontSize={LABEL_FONT} fontWeight={weight} fill={fill} className="tabular-nums">
        {text}
      </text>
    </g>
  );
}

export function ComboChart({
  groups,
  label,
  fmtAxis,
  fmtRunning,
  runningColor = "var(--viz-running)",
  plotHeight = 230,
  tooltip,
  describe,
  missingLabel = "Not imported",
}: {
  groups: ComboGroup[];
  /** What the chart shows, for assistive technology. */
  label: string;
  /** A gridline's value on the left, short. */
  fmtAxis: (n: number) => string;
  /** The running total's value on the right, short. */
  fmtRunning: (n: number) => string;
  runningColor?: string;
  plotHeight?: number;
  tooltip: (i: number) => ReactNode;
  describe: (i: number) => string;
  /** Written on a stretch of groups with no columns at all (none of it imported). */
  missingLabel?: string;
}) {
  const [ref, width] = useWidth();
  const hatchId = `hatch-${useId().replace(/[^\w-]/g, "")}`;
  const [active, setActive] = useState<number | null>(null);
  const n = groups.length;
  const k = Math.max(1, ...groups.map((g) => g.bars.length));
  const MARGIN = marginsFor(width);
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const slot = n ? plotW / n : 0;
  // One column a group: a hairline gap at least. Several: side by side, a little room between groups.
  const bw =
    k === 1
      ? slot >= 6
        ? Math.min(BAR_MAX, slot - 2)
        : Math.max(1, slot - 1)
      : Math.max(1, Math.min(BAR_MAX, (Math.min(slot * 0.94, slot - 4) - GAP * (k - 1)) / k));
  const groupW = k * bw + (k - 1) * GAP;
  const cx = (i: number) => MARGIN.left + slot * (i + 0.5);
  const barX = (i: number, j: number, of: number) => cx(i) - (of * bw + (of - 1) * GAP) / 2 + j * (bw + GAP);

  // Labels on every column only when each fits; otherwise just the ones that matter.
  const room = k === 1 ? slot : bw + GAP + 6;
  const labelled = groups.flatMap((g) => g.bars.filter((b) => b.label && b.value !== null));
  const allFit = labelled.every((b) => pillWidth(b.label!) <= room);
  const showLabel = (g: ComboGroup, b: ComboBar) => !!b.label && b.value !== null && (allFit || !!g.keepLabel);
  const showNotes = allFit && groups.some((g) => g.bars.some((b) => b.note));
  const top = showNotes ? 40 : groups.some((g) => g.bars.some((b) => showLabel(g, b))) ? 22 : 10;
  const plotH = plotHeight;

  const values = groups.flatMap((g) => g.bars.map((b) => b.value).filter((v): v is number => v !== null));
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const yTicks = niceTicks(max, 4);
  const yMax = yTicks.at(-1)! || 1;
  const yMin = min < 0 ? -niceTicks(-min, 1).at(-1)! : 0;
  const y = (v: number) => top + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const lines = yTicks.length > 1 ? yTicks : [0, yMax];

  // The running total's scale: on the same gridlines, in steps of its own.
  const runs = groups.map((g) => g.running);
  const known = runs.filter((r): r is number => r !== null);
  const runMax = Math.max(0, ...known);
  const runMin = Math.min(0, ...known);
  const aligned = yMin === 0 && runMin >= 0;
  const [rLo, rHi] = aligned ? [0, niceStep(runMax / (lines.length - 1)) * (lines.length - 1)] : [runMin, Math.max(runMax, 0) * 1.1 || 1];
  const yr = (v: number) => top + (1 - (v - rLo) / (rHi - rLo || 1)) * plotH;
  const runAt = (py: number) => rLo + (rHi - rLo) * (1 - (py - top) / plotH);

  // Stretches of groups with nothing imported, drawn as one hatched band each: never as $0.
  const missingRuns: Array<[number, number]> = [];
  groups.forEach((g, i) => {
    if (!g.bars.length || g.bars.some((b) => b.value !== null)) return;
    const last = missingRuns.at(-1);
    if (last && last[1] === i - 1) last[1] = i;
    else missingRuns.push([i, i]);
  });

  const segments: Array<Array<[number, number]>> = [];
  runs.forEach((r, i) => {
    if (r === null) return;
    if (i === 0 || runs[i - 1] === null || !segments.length) segments.push([]);
    segments.at(-1)!.push([cx(i), yr(r)]);
  });

  // Ticks: every group when they fit, otherwise the major ones that don't collide.
  const subs = k > 1 && bw >= 16 && groups.some((g) => g.bars.some((b) => b.sub));
  const twoLine = subs || groups.some((g) => g.tick.bottom);
  const allTicks = groups.every((g) => tickWidth(g.tick.top) <= slot);
  const ticks: number[] = [];
  let lastRight = -Infinity;
  groups.forEach((g, i) => {
    if (allTicks) return ticks.push(i);
    if (!g.tick.major) return;
    const w = tickWidth(g.tick.top);
    if (cx(i) - w / 2 < lastRight + 6) return;
    ticks.push(i);
    lastRight = cx(i) + w / 2;
  });
  const height = top + plotH + (twoLine ? 34 : 20) + 4;

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

  // Beside the hovered group, never over it.
  const tipRight = active !== null && cx(active) < width * 0.6;
  const tipLeft = active === null ? 0 : tipRight ? cx(active) + groupW / 2 + 10 : cx(active) - groupW / 2 - 10;

  return (
    <div
      ref={ref}
      className="relative mt-2 select-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
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
            <pattern id={hatchId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={6} height={6} fill="var(--border)" opacity={0.25} />
              <line x1={0} y1={0} x2={0} y2={6} stroke="var(--border)" strokeWidth={2} />
            </pattern>
          </defs>
          {missingRuns.map(([a, b]) => {
            const x = MARGIN.left + slot * a;
            const w = slot * (b - a + 1);
            const lw = pillWidth(missingLabel) + 8;
            return (
              <g key={`m${a}`}>
                <rect x={x} y={top} width={w} height={plotH} fill={`url(#${hatchId})`} />
                {w >= lw + 8 && (
                  <>
                    <rect x={x + w / 2 - lw / 2} y={top + 8} width={lw} height={18} rx={4} fill="var(--surface)" />
                    <text x={x + w / 2} y={top + 21} textAnchor="middle" fontSize={AXIS_FONT} fill="var(--muted)">{missingLabel}</text>
                  </>
                )}
              </g>
            );
          })}
          {active !== null && <rect x={MARGIN.left + slot * active} y={top} width={slot} height={plotH} fill="var(--viz-day)" opacity={0.07} />}

          {/* Gridlines with the columns' scale on the left and the running total's on the right. */}
          {lines.map((t) => (
            <g key={`g${t}`} fontSize={AXIS_FONT} className="tabular-nums">
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} stroke="var(--border)" opacity={t === 0 && yMin === 0 ? 1 : 0.6} />
              <text x={MARGIN.left - 8} y={y(t) + 3.5} textAnchor="end" fill="var(--muted)">{fmtAxis(t)}</text>
              {known.length > 0 && (
                <text x={width - MARGIN.right + 8} y={y(t) + 3.5} textAnchor="start" fill={runningColor}>{fmtRunning(runAt(y(t)))}</text>
              )}
            </g>
          ))}
          {yMin < 0 && <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(0)} y2={y(0)} stroke="var(--muted)" opacity={0.6} />}

          {groups.map((g, i) =>
            g.bars.map((b, j) => {
              if (b.value === null || b.value === 0) return null;
              const h = Math.abs(y(b.value) - y(0));
              // A day with very little still shows a sliver, so it never reads as nothing.
              const yTop = h < 2 ? y(0) - Math.sign(b.value) * 2 : y(b.value);
              return <path key={`${g.key}-${j}`} d={columnPath(barX(i, j, g.bars.length), bw, y(0), yTop)} fill={b.fill} className="animate-fade" />;
            }),
          )}

          {segments.map((pts, s) => (
            <path key={`s${s}`} d={monotonePath(pts)} fill="none" stroke={runningColor} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {slot >= 10 &&
            runs.map((r, i) => (r === null ? null : <circle key={`d${i}`} cx={cx(i)} cy={yr(r)} r={k > 1 ? 2.5 : 2} fill={runningColor} />))}
          {active !== null && runs[active] !== null && <circle cx={cx(active)} cy={yr(runs[active]!)} r={5} fill={runningColor} stroke="var(--surface)" strokeWidth={2} />}

          {/* The figures over the columns, on pills so the line never hides them. */}
          {groups.map((g, i) =>
            g.bars.map((b, j) => {
              if (!showLabel(g, b)) return null;
              const x = barX(i, j, g.bars.length) + bw / 2;
              const yTop = Math.min(y(b.value!), y(0));
              const lx = Math.min(Math.max(x, MARGIN.left + pillWidth(b.label!) / 2), width - MARGIN.right - pillWidth(b.label!) / 2);
              return (
                <g key={`l${g.key}-${j}`}>
                  {showNotes && b.note && <Pill x={lx} y={yTop - 19} text={b.note.text} fill={b.note.tone === "good" ? "var(--good)" : "var(--danger)"} weight={700} />}
                  <Pill x={lx} y={yTop - 4} text={b.label!} fill={b.quiet ? "var(--muted)" : "var(--text)"} weight={g.keepLabel ? 700 : 600} />
                </g>
              );
            }),
          )}

          <line x1={MARGIN.left} x2={width - MARGIN.right} y1={top + plotH} y2={top + plotH} stroke="var(--border)" />
          {ticks.map((i) => {
            const g = groups[i]!;
            const t = g.tick;
            const base = top + plotH;
            return (
              <g key={`t${i}`} textAnchor="middle">
                <text x={cx(i)} y={base + 14} fontSize={k > 1 ? 11 : AXIS_FONT} fontWeight={t.strong || k > 1 ? 700 : 600} fill="var(--text)">{t.top}</text>
                {t.bottom && (
                  <text x={cx(i)} y={base + 27} fontSize={LABEL_FONT} fontWeight={t.weekend || t.strong ? 700 : 500} fill={t.weekend ? "var(--viz-weekend)" : "var(--muted)"}>
                    {t.bottom}
                  </text>
                )}
                {subs &&
                  g.bars.map((b, j) =>
                    b.sub ? (
                      <text key={j} x={barX(i, j, g.bars.length) + bw / 2} y={base + 27} fontSize={8} fontWeight={j === g.bars.length - 1 ? 700 : 500} fill={j === g.bars.length - 1 ? "var(--text)" : "var(--muted)"}>
                        {b.sub}
                      </text>
                    ) : null,
                  )}
              </g>
            );
          })}
        </svg>
      )}
      {width === 0 && <div style={{ height: plotHeight + 70 }} />}
      {active !== null && width > 0 && (
        <div
          className="pointer-events-none absolute z-10 min-w-40 rounded-[10px] border border-border bg-surface px-3 py-2 text-xs shadow-lg"
          style={{ left: tipLeft, top: top + 4, transform: tipRight ? undefined : "translateX(-100%)" }}
        >
          {tooltip(active)}
        </div>
      )}
      {/* Every column at once, for a screen reader that would rather read than arrow through. */}
      <ul className="sr-only">
        {groups.map((g, i) => (
          <li key={g.key}>{describe(i)}</li>
        ))}
      </ul>
    </div>
  );
}

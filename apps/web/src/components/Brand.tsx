import { useId } from "react";

/** The product's name, as it is written everywhere in the UI. */
export const BRAND_NAME = "bizinsights";

/**
 * The bizinsights mark on a 28×28 grid: three rising bars in a green gradient, the tallest with a
 * top that tips upward. Every logo is drawn from these numbers: the app and auth pages, the
 * landing page (its intro builds the mark bar by bar, its final scene gathers points into it),
 * the favicon (app/icon.svg) and the store icons (scripts/make-icons.py).
 */
export const MARK = {
  size: 28,
  /** Where every bar stands. */
  baseline: 25,
  barWidth: 6,
  radius: 2,
  bars: [
    { x: 3, top: 15, opacity: 0.75 },
    { x: 11, top: 9.5, opacity: 0.88 },
    { x: 19, top: 6.1, opacity: 1 },
  ],
  /** Each bar's gradient, from its top to its foot. */
  stops: ["#7be3a8", "#23935c"],
  /** Background of the tile version (favicon, app icons). */
  tile: "#1b1c19",
} as const;

/** The tallest bar: its top climbs from 9.4 at the left edge to 6.1 near the right. */
const TALL_BAR = "M19 9.4c0-1.4 1-2.6 2.4-2.9l2.1-.4c.8-.2 1.5.4 1.5 1.2V23c0 1.1-.9 2-2 2h-2c-1.1 0-2-.9-2-2z";

/** The top edge of bar `i` at `x` (for drawing the mark from points). */
export function barTop(i: number, x: number) {
  const bar = MARK.bars[i];
  return i === 2 ? Math.max(bar.top, 9.4 - (x - bar.x) * 0.66) : bar.top;
}

/** One bar as SVG path data, so it can be clipped or animated on its own. */
export function barPath(i: number) {
  if (i === 2) return TALL_BAR;
  const { x, top } = MARK.bars[i];
  const { baseline: b, barWidth: w, radius: r } = MARK;
  return `M${x} ${top + r}a${r} ${r} 0 0 1 ${r}-${r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}V${b - r}a${r} ${r} 0 0 1-${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1-${r}-${r}z`;
}

/** The bars' gradient: each bar runs from light at its own top to deep green at its foot. */
export function MarkGradient({ id }: { id: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={MARK.stops[0]} />
      <stop offset="100%" stopColor={MARK.stops[1]} />
    </linearGradient>
  );
}

/**
 * The mark. `tile` draws it on its dark rounded square, as the favicon and app icons show it.
 * Decorative unless it gets a `title`.
 */
export function BrandMark({ size = 28, tile = false, className, title }: { size?: number; tile?: boolean; className?: string; title?: string }) {
  const id = `brand-${useId().replace(/[^\w-]/g, "")}`;
  const bars = MARK.bars.map((b, i) => <path key={i} d={barPath(i)} fill={`url(#${id})`} opacity={b.opacity} />);
  return (
    <svg
      viewBox="0 0 28 28"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <MarkGradient id={id} />
      </defs>
      {tile ? (
        <>
          <rect width="28" height="28" rx="6.5" fill={MARK.tile} />
          <g transform="translate(14 14) scale(0.76) translate(-14 -15.55)">{bars}</g>
        </>
      ) : (
        bars
      )}
    </svg>
  );
}

/** Mark + name, the logo in headers and footers. Inherits its text colour. */
export function BrandLogo({ size = 28, className = "", tile = false }: { size?: number; className?: string; tile?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <BrandMark size={size} tile={tile} />
      {BRAND_NAME}
    </span>
  );
}

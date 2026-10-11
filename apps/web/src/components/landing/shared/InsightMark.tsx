import { useId } from "react";

/**
 * The Insights mark, on a 32×32 grid: a gradient intelligence core, three orbit points joined to
 * it by fine connection lines, and an outer ring left open at the top right. The intro, the nav
 * and the final scene all draw from these numbers so the mark is identical wherever it lands.
 */
export const MARK = {
  size: 32,
  center: 16,
  coreR: 4.2,
  orbitR: 8.6,
  dotR: 1.85,
  ringR: 13,
  /** Orbit point angles in degrees (SVG: 0° is 3 o'clock, positive is clockwise). */
  orbitAngles: [-90, 30, 150],
  /** The ring's open gap, in degrees: it runs clockwise from `ringStart` round to `ringEnd`. */
  ringStart: -15,
  ringEnd: -75,
} as const;

const rad = (deg: number) => (deg * Math.PI) / 180;
const at = (r: number, deg: number) => ({ x: MARK.center + r * Math.cos(rad(deg)), y: MARK.center + r * Math.sin(rad(deg)) });

/** Orbit point centres. */
export const ORBIT_POINTS = MARK.orbitAngles.map((a) => at(MARK.orbitR, a));

/** The open outer ring as an SVG path (300° arc). */
export const RING_PATH = (() => {
  const s = at(MARK.ringR, MARK.ringStart);
  const e = at(MARK.ringR, MARK.ringEnd);
  return `M ${s.x.toFixed(3)} ${s.y.toFixed(3)} A ${MARK.ringR} ${MARK.ringR} 0 1 1 ${e.x.toFixed(3)} ${e.y.toFixed(3)}`;
})();

/** Gradient stops shared by every rendering of the core. */
export const CORE_STOPS = [
  { offset: "0%", color: "#A798FF" },
  { offset: "55%", color: "#5EA6FF" },
  { offset: "100%", color: "#65D8D0" },
] as const;

export function InsightMark({ size = 28, className, title }: { size?: number; className?: string; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={`core-${id}`} x1="10" y1="10" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          {CORE_STOPS.map((s) => (
            <stop key={s.offset} offset={s.offset} stopColor={s.color} />
          ))}
        </linearGradient>
        <radialGradient id={`glow-${id}`} cx="16" cy="16" r="9" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#8C7BFF" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#8C7BFF" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="16" cy="16" r="9" fill={`url(#glow-${id})`} />
      <path d={RING_PATH} stroke="currentColor" strokeOpacity="0.85" strokeWidth="1.6" strokeLinecap="round" />
      {ORBIT_POINTS.map((p, i) => (
        <line key={`l${i}`} x1="16" y1="16" x2={p.x} y2={p.y} stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.9" />
      ))}
      {ORBIT_POINTS.map((p, i) => (
        <circle key={`d${i}`} cx={p.x} cy={p.y} r={MARK.dotR} fill="currentColor" />
      ))}
      <circle cx="16" cy="16" r={MARK.coreR} fill={`url(#core-${id})`} />
    </svg>
  );
}

/** Mark + wordmark, as used in the nav and footer. */
export function InsightLogo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 text-lp-text ${className}`}>
      <InsightMark size={size} />
      <span className="text-[15px] font-semibold tracking-[0.16em]">INSIGHTS</span>
    </span>
  );
}

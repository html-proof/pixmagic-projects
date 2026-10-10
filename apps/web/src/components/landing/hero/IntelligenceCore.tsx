"use client";
import { motion, useTransform, type MotionValue } from "motion/react";
import { useId, useRef, type ReactNode } from "react";
import { usePauseWhenHidden } from "@/hooks/usePauseWhenHidden";
import { MARK } from "../shared/InsightMark";
import { CORE_EXTENT, CORE_R, OUTER_RING_R, RINGS } from "./HeroLayout";

/** SVG units per sphere radius. The core's SVGs use a viewBox centred on the sphere. */
const U = 100;
const HALF = CORE_EXTENT * U;
const VIEWBOX = `${-HALF} ${-HALF} ${HALF * 2} ${HALF * 2}`;

const rad = (deg: number) => (deg * Math.PI) / 180;
const pt = (r: number, deg: number) => `${(r * Math.cos(rad(deg))).toFixed(2)} ${(r * Math.sin(rad(deg))).toFixed(2)}`;

/** The open outer ring, with its gap where the Insight mark has it (top right). */
const OUTER = (() => {
  const r = OUTER_RING_R * U;
  return `M ${pt(r, MARK.ringStart)} A ${r} ${r} 0 1 1 ${pt(r, MARK.ringEnd)}`;
})();

/**
 * Each ring split into the half behind the sphere (top, drawn under it) and the half in front
 * (bottom, drawn over it), so the sphere reads as a solid object inside its orbits.
 */
const RING_PATHS = RINGS.map((ring) => {
  const r = ring.r * U;
  const ry = r * ring.squash;
  return {
    tilt: ring.tilt,
    back: `M ${-r} 0 A ${r} ${ry} 0 0 1 ${r} 0`,
    front: `M ${r} 0 A ${r} ${ry} 0 0 1 ${-r} 0`,
    /** Resting place of the orbit point when nothing moves (on the front half). */
    still: { x: r * Math.cos(0.7 + ring.period / 30), y: ry * Math.abs(Math.sin(0.7 + ring.period / 30)) },
  };
});

/*
 * The orbit points ride their rings on the compositor. An ellipse is two sine waves a quarter turn
 * apart, so each point sits in two nested full-size layers: one swings left-right (rx) and one
 * up-down (ry), both eased as a sine, inside a wrapper rotated by the ring's tilt. A percentage
 * translate of a full-size layer is a percentage of the core, so the orbit scales with it.
 * (They used to be SMIL <animateMotion>, which re-laid out the SVG on the main thread every frame:
 * on a mid-range phone that alone held the hero at ~23 frames a second instead of ~36.)
 */
const SINE = `linear(${Array.from({ length: 17 }, (_, k) => {
  const s = k / 16;
  return `${((1 - Math.cos(Math.PI * s)) / 2).toFixed(4)} ${(s * 100).toFixed(2)}%`;
}).join(", ")})`;
/** Browsers without `linear()` (Safari < 17.2) keep the closest cubic to a sine half-wave. */
const SINE_FALLBACK = "cubic-bezier(0.37, 0, 0.63, 1)";
/** Each ring's point starts this many seconds further round. */
const STAGGER = 7;
/** SVG units as a percentage of the core element (which spans the whole viewBox). */
const pct = (units: number) => `${((units / (HALF * 2)) * 100).toFixed(3)}%`;

const ORBIT_CSS = RINGS.map((ring, i) => {
  const half = ring.period / 2;
  const rx = pct(ring.r * U);
  const ry = pct(ring.r * U * ring.squash);
  const start = -i * STAGGER;
  // From the right-hand end: x runs +rx → -rx while y goes 0 → +ry → 0 (the front half, below the
  // sphere's centre), then back round behind it. The front copy shows for that first half only.
  return [
    `@keyframes lp-orbit-x-${i}{from{transform:translateX(${rx})}to{transform:translateX(-${rx})}}`,
    `@keyframes lp-orbit-y-${i}{from{transform:translateY(-${ry})}to{transform:translateY(${ry})}}`,
    `.lp-orbit-x-${i}{animation:lp-orbit-x-${i} ${half}s ${SINE_FALLBACK} ${start}s infinite alternate;animation-timing-function:${SINE}}`,
    `.lp-orbit-y-${i}{animation:lp-orbit-y-${i} ${half}s ${SINE_FALLBACK} ${start - ring.period / 4}s infinite alternate;animation-timing-function:${SINE}}`,
    `.lp-orbit-front-${i}{animation:lp-orbit-front ${ring.period}s step-end ${start}s infinite}`,
  ].join("\n");
})
  .concat("@keyframes lp-orbit-front{0%{opacity:1}50%{opacity:0}100%{opacity:0}}")
  .join("\n");

/** A dot of radius `r` (SVG units), centred in its full-size orbit layer. */
function Dot({ r, className }: { r: number; className: string }) {
  const size = pct(r * 2);
  return (
    <span
      className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** Ring `index`'s moving point. `front`: the copy drawn over the sphere, shown on the front half only. */
function OrbitPoint({ index, front = false, children }: { index: number; front?: boolean; children: ReactNode }) {
  return (
    <div className="absolute inset-0" style={{ transform: `rotate(${RINGS[index].tilt}deg)` }}>
      <div className={`lp-loop absolute inset-0 lp-orbit-x-${index}`}>
        <div className={`lp-loop absolute inset-0 lp-orbit-y-${index}`}>
          {front ? <div className={`lp-loop absolute inset-0 lp-orbit-front-${index}`}>{children}</div> : children}
        </div>
      </div>
    </div>
  );
}

/** Layered gradients only (no box-shadow), so the shading holds at every size and scale. */
const SPHERE_BG = [
  "radial-gradient(circle at 33% 27%, rgb(255 255 255 / 0.62) 0%, rgb(255 255 255 / 0) 20%)",
  "radial-gradient(circle at 72% 80%, rgb(101 216 208 / 0.5) 0%, rgb(101 216 208 / 0) 42%)",
  "radial-gradient(circle closest-side, rgb(167 152 255 / 0) 88%, rgb(167 152 255 / 0.45) 97%, rgb(167 152 255 / 0) 100%)",
  "radial-gradient(circle at 40% 34%, #b4a8ff 0%, #8c7bff 26%, #5a6fe0 55%, #26305f 82%, #141a33 100%)",
].join(", ");

const ENERGY_BG =
  "conic-gradient(from 90deg, rgb(94 166 255 / 0) 0deg, rgb(94 166 255 / 0.55) 70deg, rgb(167 152 255 / 0) 150deg, rgb(101 216 208 / 0.4) 230deg, rgb(94 166 255 / 0) 320deg)";

export interface CoreMotion {
  /** Offset of the core from the box centre, as CSS percentages of the box ("-39%"). */
  x: MotionValue<string>;
  y: MotionValue<string>;
  scale: MotionValue<number>;
  opacity: MotionValue<number>;
  /** Ring visibility 0..1. */
  rings: MotionValue<number>;
  /** Energy 0..1: the halo brightens as data arrives. */
  glow: MotionValue<number>;
}

/**
 * The Insight intelligence core: a shaded sphere with soft violet/blue energy inside, three
 * tilted orbital rings each carrying one orbit point, and the open outer ring of the Insight mark.
 * Sized as a share of the visual box (`CORE_R`), so the canvas particles can orbit it exactly.
 * Purely decorative; the hero describes the story for screen readers.
 */
export function IntelligenceCore({ motion: m, still = false }: { motion: CoreMotion; still?: boolean }) {
  const halo = useTransform(m.glow, (g) => 0.3 + g * 0.7);
  const gradient = `hero-ring-${useId().replace(/:/g, "")}`;
  const size = `${CORE_R * 2 * CORE_EXTENT * 100}%`;
  // The loops run only while the core is on screen and visible; the orbit points also need the rings.
  const coreRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const frontRef = useRef<HTMLDivElement>(null);
  usePauseWhenHidden(coreRef, [m.opacity]);
  usePauseWhenHidden(backRef, [m.opacity, m.rings]);
  usePauseWhenHidden(frontRef, [m.opacity, m.rings]);
  const paused = still ? {} : { "data-lp-paused": "" };
  const spin = still ? "" : "lp-loop animate-spin";

  return (
    <motion.div aria-hidden className="pointer-events-none absolute inset-0" style={{ x: m.x, y: m.y }}>
      {!still && <style>{ORBIT_CSS}</style>}
      <motion.div
        ref={coreRef}
        {...paused}
        className="absolute left-1/2 top-1/2 aspect-square -translate-x-1/2 -translate-y-1/2 will-change-transform"
        style={{ width: size, scale: m.scale, opacity: m.opacity }}
      >
        <motion.div
          className="absolute inset-[12%] rounded-full"
          style={{
            opacity: halo,
            background:
              "radial-gradient(circle closest-side, rgb(140 123 255 / 0.42), rgb(94 166 255 / 0.12) 48%, rgb(94 166 255 / 0) 100%)",
          }}
        />

        <motion.div ref={backRef} {...paused} className="absolute inset-0" style={{ opacity: m.rings }}>
          <svg viewBox={VIEWBOX} className={`absolute inset-0 size-full overflow-visible ${spin}`} style={still ? undefined : { animationDuration: "160s" }} fill="none">
            <path d={OUTER} stroke="rgb(255 255 255 / 0.17)" strokeWidth={1} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
          <svg viewBox={VIEWBOX} className="absolute inset-0 size-full overflow-visible" fill="none">
            {RING_PATHS.map((ring, i) => (
              <g key={i} transform={`rotate(${ring.tilt})`}>
                <path d={ring.back} stroke="rgb(255 255 255 / 0.1)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                {still && <circle r={4.5} fill="#a798ff" opacity={0.75} cx={-ring.still.x} cy={-ring.still.y} />}
              </g>
            ))}
          </svg>
          {!still &&
            RINGS.map((_, i) => (
              <OrbitPoint key={i} index={i}>
                <Dot r={4.5} className="bg-[#a798ff] opacity-75" />
              </OrbitPoint>
            ))}
        </motion.div>

        <div className="absolute left-1/2 top-1/2 aspect-square w-[31.25%] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-full" style={{ background: SPHERE_BG }}>
          <div
            className={`absolute inset-0 rounded-full opacity-70 mix-blend-screen ${spin}`}
            style={{
              animationDuration: still ? undefined : "22s",
              background: ENERGY_BG,
              maskImage: "radial-gradient(circle closest-side, black 25%, transparent 78%)",
              WebkitMaskImage: "radial-gradient(circle closest-side, black 25%, transparent 78%)",
            }}
          />
        </div>

        <motion.div ref={frontRef} {...paused} className="absolute inset-0" style={{ opacity: m.rings }}>
          <svg viewBox={VIEWBOX} className="absolute inset-0 size-full overflow-visible" fill="none">
            <defs>
              <linearGradient id={gradient} x1="-250" y1="0" x2="250" y2="0" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#a798ff" stopOpacity="0.15" />
                <stop offset="50%" stopColor="#a798ff" stopOpacity="0.55" />
                <stop offset="100%" stopColor="#5ea6ff" stopOpacity="0.2" />
              </linearGradient>
            </defs>
            {RING_PATHS.map((ring, i) => (
              <g key={i} transform={`rotate(${ring.tilt})`}>
                <path d={ring.front} stroke={`url(#${gradient})`} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                {still && (
                  <>
                    <circle r={16} fill="#8c7bff" opacity={0.18} cx={ring.still.x} cy={ring.still.y} />
                    <circle r={5.5} fill="#f7f9fc" cx={ring.still.x} cy={ring.still.y} />
                  </>
                )}
              </g>
            ))}
          </svg>
          {!still &&
            RINGS.map((_, i) => (
              <OrbitPoint key={i} index={i} front>
                <Dot r={16} className="bg-[#8c7bff] opacity-[0.18]" />
                <Dot r={5.5} className="bg-[#f7f9fc]" />
              </OrbitPoint>
            ))}
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

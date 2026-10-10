"use client";
import { motion, useTransform, type MotionValue } from "motion/react";
import { useId } from "react";
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
 * (bottom, drawn over it), so the sphere reads as a solid object inside its orbits. `orbit` is
 * the full ellipse, starting on the right and running clockwise: front half first, then back.
 */
const RING_PATHS = RINGS.map((ring) => {
  const r = ring.r * U;
  const ry = r * ring.squash;
  return {
    tilt: ring.tilt,
    period: ring.period,
    back: `M ${-r} 0 A ${r} ${ry} 0 0 1 ${r} 0`,
    front: `M ${r} 0 A ${r} ${ry} 0 0 1 ${-r} 0`,
    orbit: `M ${r} 0 A ${r} ${ry} 0 1 1 ${-r} 0 A ${r} ${ry} 0 1 1 ${r} 0`,
    /** Resting place of the orbit point when nothing moves (on the front half). */
    still: { x: r * Math.cos(0.7 + ring.period / 30), y: ry * Math.abs(Math.sin(0.7 + ring.period / 30)) },
  };
});

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

  return (
    <motion.div aria-hidden className="pointer-events-none absolute inset-0" style={{ x: m.x, y: m.y }}>
      <motion.div
        className="absolute left-1/2 top-1/2 aspect-square -translate-x-1/2 -translate-y-1/2"
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

        <motion.svg viewBox={VIEWBOX} className="absolute inset-0 size-full overflow-visible" fill="none" style={{ opacity: m.rings }}>
          <g>
            <path d={OUTER} stroke="rgb(255 255 255 / 0.17)" strokeWidth={1} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {!still && (
              <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="160s" repeatCount="indefinite" />
            )}
          </g>
          {RING_PATHS.map((ring, i) => (
            <g key={i} transform={`rotate(${ring.tilt})`}>
              <path d={ring.back} stroke="rgb(255 255 255 / 0.1)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <circle r={4.5} fill="#a798ff" opacity={0.75} {...(still ? { cx: -ring.still.x, cy: -ring.still.y } : {})}>
                {!still && <animateMotion dur={`${ring.period}s`} begin={`${-i * 7}s`} repeatCount="indefinite" path={ring.orbit} />}
              </circle>
            </g>
          ))}
        </motion.svg>

        <div className="absolute left-1/2 top-1/2 aspect-square w-[31.25%] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-full" style={{ background: SPHERE_BG }}>
          <div
            className={`absolute inset-0 rounded-full opacity-70 mix-blend-screen ${still ? "" : "animate-spin"}`}
            style={{
              animationDuration: still ? undefined : "22s",
              background: ENERGY_BG,
              maskImage: "radial-gradient(circle closest-side, black 25%, transparent 78%)",
              WebkitMaskImage: "radial-gradient(circle closest-side, black 25%, transparent 78%)",
            }}
          />
        </div>

        <motion.svg viewBox={VIEWBOX} className="absolute inset-0 size-full overflow-visible" fill="none" style={{ opacity: m.rings }}>
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
              <circle r={16} fill="#8c7bff" opacity={0.18} {...(still ? { cx: ring.still.x, cy: ring.still.y } : {})}>
                {!still && (
                  <>
                    <animateMotion dur={`${ring.period}s`} begin={`${-i * 7}s`} repeatCount="indefinite" path={ring.orbit} />
                    <animate attributeName="opacity" values="0.18;0" keyTimes="0;0.5" calcMode="discrete" dur={`${ring.period}s`} begin={`${-i * 7}s`} repeatCount="indefinite" />
                  </>
                )}
              </circle>
              <circle r={5.5} fill="#f7f9fc" {...(still ? { cx: ring.still.x, cy: ring.still.y } : {})}>
                {!still && (
                  <>
                    <animateMotion dur={`${ring.period}s`} begin={`${-i * 7}s`} repeatCount="indefinite" path={ring.orbit} />
                    <animate attributeName="opacity" values="1;0" keyTimes="0;0.5" calcMode="discrete" dur={`${ring.period}s`} begin={`${-i * 7}s`} repeatCount="indefinite" />
                  </>
                )}
              </circle>
            </g>
          ))}
        </motion.svg>
      </motion.div>
    </motion.div>
  );
}

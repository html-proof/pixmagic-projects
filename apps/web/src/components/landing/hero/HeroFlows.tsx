"use client";
import { motion, useTransform, type MotionValue } from "motion/react";
import { useId, useRef, type CSSProperties, type ReactNode } from "react";
import { usePauseWhenHidden } from "@/hooks/usePauseWhenHidden";
import { segment } from "@/lib/motion";
import {
  BOX,
  FLOWS,
  STACKED_FLOWS,
  WIDE_FLOWS,
  flowsEnter,
  flowsExit,
  nodeActive,
  stackedFlowDraw,
  stackedFlowOpacity,
  wideFlowDraw,
  type FlowDef,
  type FlowGeometry,
} from "./HeroLayout";

type Box = (typeof BOX)[keyof typeof BOX];

const pctX = (box: Box, x: number) => `${(x / box.w) * 100}%`;
const pctY = (box: Box, y: number) => `${(y / box.h) * 100}%`;

const PULSE_SECONDS = [3.4, 3.9, 4.4];

/**
 * Line, light pulse and nodes of one flow, inside an SVG laid over the visual box. The line
 * draws itself with `draw`, each node lights up as the line reaches it, and once the whole path
 * exists a short bright dash keeps travelling along it: a CSS loop that only runs while the flow
 * is on screen and visible (`fade` is the opacity of the diagram it belongs to).
 */
function FlowLine({
  box,
  geo,
  draw,
  fade,
  index,
  still,
  vertical,
}: {
  box: Box;
  geo: FlowGeometry;
  draw: MotionValue<number>;
  fade: MotionValue<number>;
  index: number;
  still: boolean;
  vertical: boolean;
}) {
  const id = `hero-flow-${useId().replace(/:/g, "")}`;
  const shown = useTransform(draw, (d) => (d > 0.001 ? 1 : 0));
  const track = useTransform(draw, (d) => segment(d, 0, 0.08));
  const pulse = useTransform(draw, (d) => segment(d, 0.9, 1));
  const svgRef = useRef<SVGSVGElement>(null);
  usePauseWhenHidden(svgRef, [pulse, fade]);
  const first = geo.nodes[0];
  const last = geo.nodes[geo.nodes.length - 1];
  return (
    <svg ref={svgRef} data-lp-paused="" viewBox={`0 0 ${box.w} ${box.h}`} className="absolute inset-0 size-full overflow-visible" fill="none">
      <defs>
        <linearGradient
          id={id}
          gradientUnits="userSpaceOnUse"
          x1={vertical ? first.x : first.x - 200}
          y1={vertical ? first.y - 60 : first.y}
          x2={last.x}
          y2={last.y}
        >
          <stop offset="0%" stopColor="#8c7bff" />
          <stop offset="60%" stopColor="#5ea6ff" />
          <stop offset="100%" stopColor="#65d8d0" />
        </linearGradient>
      </defs>
      <motion.path d={geo.d} stroke="rgb(255 255 255 / 0.07)" strokeWidth={vertical ? 1.2 : 1.4} style={{ opacity: track }} />
      <motion.path d={geo.d} stroke={`url(#${id})`} strokeWidth={vertical ? 1.4 : 1.8} style={{ pathLength: draw, opacity: shown }} />
      {!still && (
        <motion.g style={{ opacity: pulse }}>
          <path
            d={geo.d}
            className="lp-loop"
            stroke="#f7f9fc"
            strokeWidth={vertical ? 2 : 2.6}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray="0.05 1.2"
            strokeDashoffset={0.05}
            style={{ animation: `lp-flow-pulse ${PULSE_SECONDS[index]}s linear ${index * 0.7}s infinite` }}
          />
        </motion.g>
      )}
      {geo.nodes.map((n, j) => (
        <FlowNode key={j} x={n.x} y={n.y} at={geo.at[j]} draw={draw} final={j === geo.nodes.length - 1} size={vertical ? 5 : 7} />
      ))}
    </svg>
  );
}

function FlowNode({ x, y, at, draw, final, size }: { x: number; y: number; at: number; draw: MotionValue<number>; final: boolean; size: number }) {
  const active = useTransform(draw, (d) => nodeActive(d, at));
  const present = useTransform(draw, (d) => segment(d, at - 0.12, at));
  const halo = useTransform(active, (a) => a * (final ? 0.32 : 0.2));
  const haloScale = useTransform(active, (a) => 0.4 + a * 0.6);
  const r = final ? size + 2 : size;
  return (
    <g>
      <motion.circle cx={x} cy={y} r={r * 2.6} fill="#8c7bff" style={{ opacity: halo, scale: haloScale }} />
      <motion.circle cx={x} cy={y} r={r} fill="#080a0d" stroke="rgb(255 255 255 / 0.28)" strokeWidth={1.2} style={{ opacity: present }} />
      <motion.circle cx={x} cy={y} r={r * 0.62} fill={final ? "#a798ff" : "#f7f9fc"} style={{ opacity: active }} />
    </g>
  );
}

function Label({ draw, at, className, style, children }: { draw: MotionValue<number>; at: number; className: string; style: CSSProperties; children: ReactNode }) {
  const opacity = useTransform(draw, (d) => nodeActive(d, at));
  const y = useTransform(opacity, (o) => (1 - o) * 6);
  return (
    <motion.span className={className} style={{ ...style, opacity, y }}>
      {children}
    </motion.span>
  );
}

/* ---- Wide: three rows radiating from the core ----------------------------------------------- */

function WideFlow({
  flow,
  geo,
  k,
  progress,
  fade,
  still,
}: {
  flow: FlowDef;
  geo: FlowGeometry;
  k: number;
  progress: MotionValue<number>;
  fade: MotionValue<number>;
  still: boolean;
}) {
  const box = BOX.wide;
  const draw = useTransform(progress, (p) => wideFlowDraw(p, k));
  const title = useTransform(draw, (d) => segment(d, 0.05, 0.3));
  const first = geo.nodes[0];
  return (
    <div className="absolute inset-0">
      <FlowLine box={box} geo={geo} draw={draw} fade={fade} index={k} still={still} vertical={false} />
      <motion.span
        className="lp-eyebrow absolute -translate-y-full whitespace-nowrap pb-5 text-[10.5px] xl:text-[11.5px]"
        style={{ left: pctX(box, first.x), top: pctY(box, first.y), opacity: title, x: "-0.75em" }}
      >
        <span className="text-lp-violet-bright">0{k + 1}</span>
        <span className="ml-2.5">{flow.title}</span>
      </motion.span>
      {geo.nodes.map((n, j) => (
        <Label
          key={j}
          draw={draw}
          at={geo.at[j]}
          className={`absolute w-[6.2em] -translate-x-1/2 pt-3.5 text-center text-[11.5px] leading-[1.25] xl:pt-4 xl:text-[13px] ${
            j === geo.nodes.length - 1 ? "font-medium text-lp-text" : "text-lp-text-2"
          }`}
          style={{ left: pctX(box, n.x), top: pctY(box, n.y) }}
        >
          {flow.steps[j]}
        </Label>
      ))}
      {flow.ops?.map((op, j) => {
        const a = geo.nodes[j];
        const b = geo.nodes[j + 1];
        return (
          <Label
            key={`op${j}`}
            draw={draw}
            at={geo.at[j + 1]}
            className="absolute grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-lp-line-strong bg-lp-bg font-lp-mono text-[12px] leading-none text-lp-text"
            style={{ left: pctX(box, (a.x + b.x) / 2), top: pctY(box, a.y) }}
          >
            {op}
          </Label>
        );
      })}
    </div>
  );
}

/**
 * Stage 3, wide layout: the shopping journey, the customer path and the net sales arithmetic
 * branch from the core as three rows and build one after another.
 */
export function HeroFlowsWide({ progress, still = false }: { progress: MotionValue<number>; still?: boolean }) {
  const opacity = useTransform(progress, (p) => flowsEnter(p) * flowsExit(p));
  return (
    <motion.div aria-hidden className="pointer-events-none absolute inset-0" style={{ opacity }}>
      {FLOWS.map((flow, k) => (
        <WideFlow key={flow.id} flow={flow} geo={WIDE_FLOWS[k]} k={k} progress={progress} fade={opacity} still={still} />
      ))}
    </motion.div>
  );
}

/* ---- Stacked: one vertical flow at a time --------------------------------------------------- */

function StackedFlow({ flow, geo, k, progress, still }: { flow: FlowDef; geo: FlowGeometry; k: number; progress: MotionValue<number>; still: boolean }) {
  const box = BOX.stacked;
  const draw = useTransform(progress, (p) => stackedFlowDraw(p, k));
  const opacity = useTransform(progress, (p) => stackedFlowOpacity(p, k));
  return (
    <motion.div className="absolute inset-0" style={{ opacity }}>
      <FlowLine box={box} geo={geo} draw={draw} fade={opacity} index={k} still={still} vertical />
      <span className="lp-eyebrow absolute left-[66%] top-[10%] w-[32%] -translate-y-1/2 text-[10.5px] leading-[1.5]">
        <span className="block text-lp-violet-bright">
          0{k + 1} / 0{FLOWS.length}
        </span>
        {flow.title}
      </span>
      {geo.nodes.map((n, j) => {
        const op = j > 0 ? flow.ops?.[j - 1] : undefined;
        const final = j === geo.nodes.length - 1;
        return (
          <Label
            key={j}
            draw={draw}
            at={geo.at[j]}
            className="absolute flex -translate-y-1/2 items-center"
            style={{ left: `calc(${pctX(box, n.x)} + 18px)`, top: pctY(box, n.y) }}
          >
            <span className={`whitespace-nowrap text-[15px] ${final ? "font-medium text-lp-text" : "text-lp-text-2"}`}>
              {op && <span className="mr-1.5 font-lp-mono text-lp-violet-bright">{op}</span>}
              {flow.steps[j]}
            </span>
          </Label>
        );
      })}
      {geo.nodes.map((n, j) => (
        <Label
          key={`n${j}`}
          draw={draw}
          at={geo.at[j]}
          className="lp-eyebrow absolute -translate-y-1/2 text-[10.5px]"
          style={{ right: `calc(${pctX(box, box.w - n.x)} + 18px)`, top: pctY(box, n.y) }}
        >
          0{j + 1}
        </Label>
      ))}
    </motion.div>
  );
}

/** Stage 3, stacked layout: the three flows take turns on a vertical spine under the core. */
export function HeroFlowsStacked({ progress, still = false }: { progress: MotionValue<number>; still?: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {FLOWS.map((flow, k) => (
        <StackedFlow key={flow.id} flow={flow} geo={STACKED_FLOWS[k]} k={k} progress={progress} still={still} />
      ))}
    </div>
  );
}

/**
 * The three flows as plain, readable lists: the reduced-motion composition on small screens,
 * where a single static spine cannot show all three at once.
 */
export function HeroFlowLists({ className = "" }: { className?: string }) {
  return (
    <div className={`grid gap-8 sm:grid-cols-3 sm:gap-6 ${className}`}>
      {FLOWS.map((flow, k) => (
        <div key={flow.id}>
          <p className="lp-eyebrow mb-4 text-[10.5px]">
            <span className="text-lp-violet-bright">0{k + 1}</span>
            <span className="ml-2.5">{flow.title}</span>
          </p>
          <div className="relative">
            <span aria-hidden className="absolute bottom-2 left-[5px] top-2 w-px bg-gradient-to-b from-lp-violet via-lp-blue to-lp-cyan opacity-60" />
            <ol className="space-y-3 pl-6">
              {flow.steps.map((step, j) => {
                const op = j > 0 ? flow.ops?.[j - 1] : undefined;
                const final = j === flow.steps.length - 1;
                return (
                  <li key={step} className={`relative text-[15px] leading-snug ${final ? "font-medium text-lp-text" : "text-lp-text-2"}`}>
                    <span
                      aria-hidden
                      className={`absolute -left-6 top-[0.45em] size-[11px] rounded-full border ${
                        final ? "border-lp-violet-bright bg-lp-violet" : "border-lp-line-strong bg-lp-bg"
                      }`}
                    />
                    {op && (
                      <span className="mr-1.5 font-lp-mono text-lp-violet-bright">
                        <span aria-hidden>{op}</span>
                        <span className="sr-only">{op === "=" ? "equals" : "minus"}</span>
                      </span>
                    )}
                    {step}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      ))}
    </div>
  );
}

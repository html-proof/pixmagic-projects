"use client";
import { motion, useInView } from "motion/react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CornerDownLeft,
  CreditCard,
  FileText,
  Minus,
  PackageSearch,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePauseWhenHidden } from "@/hooks/usePauseWhenHidden";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { EASE, riseIn, seeded } from "@/lib/motion";
import { BrandMark } from "@/components/Brand";
import { IllustrativeNote, SectionIntro } from "../shared/ui";

const QUERY = "Why did conversion fall this week?";

/** Rendered as "Analyzing checkout…" and so on; phones drop the verb so the rows fit two across. */
const ANALYSIS = ["checkout", "products", "pages", "traffic"] as const;

const PROMPTS = [
  "What caused yesterday's sales change?",
  "Where are customers abandoning checkout?",
  "Which products get attention but don't convert?",
  "Are returning customers spending more?",
  "What changed since last week?",
] as const;

type Tone = "warning" | "blue" | "steady";
type Direction = "up" | "down" | "steady";

interface Metric {
  label: string;
  prev: number;
  now: number;
  tone: Tone;
  direction: Direction;
}

interface Signal {
  title: string;
  icon: LucideIcon;
  text: string;
  /**
   * Bar lengths are shapes, not measurements: they only show the direction of the change the
   * sentence describes (the section is labelled illustrative and no value is ever printed).
   * Every card pairs the stage that moved with the one before it, so all three read the same way.
   */
  metrics: [Metric, Metric];
}

const SIGNALS: Signal[] = [
  {
    title: "Checkout",
    icon: CreditCard,
    text: "More visits stopped after starting checkout than the week before.",
    metrics: [
      { label: "Started checkout", prev: 0.56, now: 0.54, tone: "steady", direction: "steady" },
      { label: "Left after starting checkout", prev: 0.4, now: 0.66, tone: "warning", direction: "up" },
    ],
  },
  {
    title: "Product",
    icon: PackageSearch,
    text: "A product drew more views but fewer add‑to‑carts.",
    metrics: [
      { label: "Product views", prev: 0.46, now: 0.74, tone: "blue", direction: "up" },
      { label: "Add-to-carts", prev: 0.58, now: 0.34, tone: "warning", direction: "down" },
    ],
  },
  {
    title: "Pages",
    icon: FileText,
    text: "More visits left from the cart page.",
    metrics: [
      { label: "Reached the cart", prev: 0.5, now: 0.49, tone: "steady", direction: "steady" },
      { label: "Left from the cart page", prev: 0.34, now: 0.6, tone: "warning", direction: "up" },
    ],
  },
];

const TONE_BG: Record<Tone, string> = { warning: "bg-lp-warning", blue: "bg-lp-blue", steady: "bg-lp-text-2/55" };
const TONE_TEXT: Record<Tone, string> = { warning: "text-lp-warning", blue: "text-lp-blue", steady: "text-lp-muted" };
const DIRECTION: Record<Direction, { word: string; icon: LucideIcon }> = {
  up: { word: "Higher", icon: ArrowUpRight },
  down: { word: "Lower", icon: ArrowDownRight },
  steady: { word: "Steady", icon: Minus },
};

/*
 * The demo is a small timeline of discrete phases (a handful of React updates in total, never one
 * per frame). Analysis rows overlap a little, like real work running in parallel:
 *   0 idle · 1 typing · 2 submitted · 3–10 the four rows start and finish · 11 summary · 12 cards.
 */
const PHASE = { idle: 0, typing: 1, submitted: 2, summary: 11, final: 12 } as const;
const ROW_START = [3, 4, 6, 8] as const;
const ROW_DONE = [5, 7, 9, 10] as const;
/** Milliseconds to wait in phase `n` before moving to `n + 1` (from the submit onwards). */
const PHASE_DELAY = [0, 0, 240, 280, 300, 160, 280, 140, 300, 340, 300, 380];

/** Deterministic keystroke rhythm: quick, slightly uneven, with a beat after each word. */
const KEY_DELAYS = (() => {
  const rand = seeded(42);
  return Array.from(QUERY, (ch) => 26 + rand() * 28 + (ch === " " ? 55 : 0));
})();

type RowState = "waiting" | "active" | "done";

/**
 * "Ask the business": a command-palette window whose question types itself once it scrolls into
 * view, then shows the analysis running and the three signals it found. bizinsights has no question
 * box; its dashboard highlights answer in plain sentences, which the caption says plainly.
 */
export function AskInsight() {
  const reduced = useReducedMotion();
  const windowRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /*
   * Start once the window's top (the query bar) is well inside the viewport. A ratio threshold
   * would never be met on a short landscape phone, where the stacked window is taller than the screen.
   */
  const seen = useInView(windowRef, { once: true, margin: "0px 0px -35% 0px" });
  // The prompt list sits under the window, so watch the whole stage when pausing the cycle.
  const onScreen = useInView(stageRef, { margin: "0px 0px -10% 0px" });
  const [phase, setPhase] = useState<number>(PHASE.idle);
  const [highlight, setHighlight] = useState(-1);
  // The caret blinks from page load until the question is sent: only while the window is in view.
  usePauseWhenHidden(windowRef);

  // Less motion: skip straight to the answered state.
  useEffect(() => {
    if (reduced) setPhase(PHASE.final);
  }, [reduced]);

  useEffect(() => {
    if (reduced || !seen || phase !== PHASE.idle) return;
    const id = window.setTimeout(() => setPhase(PHASE.typing), 350);
    return () => window.clearTimeout(id);
  }, [reduced, seen, phase]);

  useEffect(() => {
    if (phase < PHASE.submitted || phase >= PHASE.final) return;
    const id = window.setTimeout(() => setPhase((p) => Math.min(PHASE.final, p + 1)), PHASE_DELAY[phase]);
    return () => window.clearTimeout(id);
  }, [phase]);

  // After the answer lands, quietly walk through other questions, only while the window is visible.
  useEffect(() => {
    if (reduced || phase < PHASE.final || !onScreen) return;
    const id = window.setTimeout(() => setHighlight((h) => (h + 1) % PROMPTS.length), highlight < 0 ? 1800 : 3400);
    return () => window.clearTimeout(id);
  }, [reduced, phase, onScreen, highlight]);

  const onTyped = useCallback(() => setPhase(PHASE.submitted), []);

  const rowState = (i: number): RowState => (phase >= ROW_DONE[i] ? "done" : phase >= ROW_START[i] ? "active" : "waiting");
  const status = phase >= PHASE.summary ? "Complete" : phase >= PHASE.submitted ? "Analyzing" : "Ready";
  const summary = phase >= PHASE.summary ? "found" : phase >= ROW_START[0] ? "working" : "idle";
  const instant = reduced;

  return (
    <section aria-labelledby="ask-insight-title" className="relative overflow-hidden bg-lp-bg py-28 md:py-36 xl:py-44">
      {/* Soft hand-over from the darker profit scene above, and atmosphere behind the window. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-[#06080A] to-transparent" />
      <div
        aria-hidden
        className="lp-grid pointer-events-none absolute inset-x-0 top-[30%] h-[70%] opacity-70 [mask-image:radial-gradient(ellipse_55%_50%_at_50%_45%,black,transparent)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[52%] h-[620px] w-[min(1100px,140vw)] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-60 [background:radial-gradient(closest-side,rgb(140_123_255/0.16),rgb(94_166_255/0.06)_55%,transparent)]"
      />

      <div className="relative mx-auto max-w-[1380px] px-4 md:px-8 xl:px-12">
        <SectionIntro
          id="ask-insight-title"
          align="center"
          // Wide enough that each sentence holds one line from tablet up (the default 4xl wraps it).
          className="max-w-[1240px]!"
          eyebrow="Plain answers"
          title={
            <>
              <span className="block">{"Don't search through reports."}</span>
              <span className="block">
                <span className="lp-gradient-text inline-block pb-[0.06em]">Ask the business.</span>
              </span>
            </>
          }
        />

        <motion.div ref={stageRef} {...riseIn(0.1, 40)} className="relative mx-auto mt-14 max-w-[1120px] md:mt-20">
          <div className="sr-only">
            <p>
              Illustration of a question window. The question “{QUERY}” is answered after bizinsights analyzes checkout, products,
              pages and traffic. bizinsights found three contributing signals:
            </p>
            <ul>
              {SIGNALS.map((s) => (
                <li key={s.title}>
                  {s.title}: {s.text}
                </li>
              ))}
            </ul>
          </div>

          <div
            ref={windowRef}
            data-lp-paused=""
            aria-hidden
            data-cursor="VIEW"
            className="relative overflow-hidden rounded-[22px] border border-lp-line-strong bg-gradient-to-b from-lp-surface to-lp-elevated shadow-[0_40px_120px_-30px_rgb(0_0_0/0.75),0_0_0_1px_rgb(255_255_255/0.02)_inset] md:rounded-[28px]"
          >
            <div aria-hidden className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />

            {/* Query bar */}
            <div className="flex items-center gap-3 border-b border-lp-line px-4 py-4 md:gap-4 md:px-7 md:py-6">
              <BrandMark size={26} className="shrink-0 md:hidden" />
              <BrandMark size={32} className="hidden shrink-0 md:block" />
              <QueryText run={phase === PHASE.typing} complete={phase >= PHASE.submitted} onDone={onTyped} />
              <motion.span
                initial={false}
                animate={
                  phase === PHASE.submitted
                    ? { backgroundColor: "rgba(140, 123, 255, 0.28)", borderColor: "rgba(167, 152, 255, 0.6)" }
                    : { backgroundColor: "rgba(255, 255, 255, 0.03)", borderColor: "rgba(255, 255, 255, 0.14)" }
                }
                transition={{ duration: 0.35, ease: EASE }}
                className="hidden shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-lp-mono text-[11px] text-lp-text-2 sm:inline-flex"
              >
                <CornerDownLeft className="size-3.5" strokeWidth={2} />
                Ask
              </motion.span>
            </div>

            {/* Status strip */}
            <div className="flex items-center justify-between gap-3 border-b border-lp-line px-4 py-3 md:px-7">
              <span className="flex items-center gap-2 font-lp-mono text-[11px] uppercase tracking-[0.14em] text-lp-muted">
                <span
                  className={`size-1.5 rounded-full transition-colors duration-500 ${
                    status === "Complete" ? "bg-lp-positive" : status === "Analyzing" ? "bg-lp-violet-bright" : "bg-lp-line-strong"
                  }`}
                />
                {status}
              </span>
              <IllustrativeNote />
            </div>

            <div className="p-4 md:p-7">
              <ol className="grid grid-cols-2 gap-2 md:gap-3 lg:grid-cols-4">
                {ANALYSIS.map((topic, i) => (
                  <AnalysisRow key={topic} topic={topic} state={rowState(i)} instant={instant} />
                ))}
              </ol>

              {/*
               * Summary line. While the rows run, a quieter "comparing" line holds the slot, so the
               * window never shows a blank band mid-sequence. Both share one grid cell (no reflow).
               */}
              <div className="mt-6 grid md:mt-8">
                <motion.p
                  initial={false}
                  animate={summary === "working" ? { opacity: 1, y: 0 } : { opacity: 0, y: summary === "found" ? -6 : 6 }}
                  transition={instant ? { duration: 0 } : { duration: 0.35, ease: EASE }}
                  className="col-start-1 row-start-1 flex items-center gap-2.5 self-center text-[15px] text-lp-muted md:text-[16px]"
                >
                  <span className="relative grid size-6 shrink-0 place-items-center">
                    <motion.span
                      animate={summary === "working" ? { scale: [1, 1.6, 1], opacity: [0.5, 0, 0.5] } : { scale: 1, opacity: 0 }}
                      transition={summary === "working" ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
                      className="absolute size-2 rounded-full bg-lp-violet-bright"
                    />
                    <span className="relative size-1.5 rounded-full bg-lp-violet-bright/80" />
                  </span>
                  Comparing this week with the week before…
                </motion.p>
                <motion.div
                  initial={false}
                  animate={summary === "found" ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
                  transition={instant ? { duration: 0 } : { duration: 0.6, ease: EASE, delay: 0.2 }}
                  className="col-start-1 row-start-1 flex flex-wrap items-center justify-between gap-x-6 gap-y-3"
                >
                  <p className="flex items-center gap-2.5 text-[17px] font-medium tracking-[-0.01em] text-lp-text md:text-[20px]">
                    <span className="relative grid size-6 shrink-0 place-items-center">
                      <span className="absolute inset-0 rounded-full bg-lp-violet/25 blur-[6px]" />
                      <span className="relative size-2 rounded-full bg-lp-violet-bright" />
                    </span>
                    bizinsights found three contributing signals.
                  </p>
                  <span className="flex items-center gap-4 pl-[34px] font-lp-mono text-[10.5px] uppercase tracking-[0.12em] text-lp-muted sm:pl-0">
                    <span className="flex items-center gap-2">
                      <span className="h-[3px] w-5 rounded-full bg-lp-line-strong" />
                      Week before
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="h-[5px] w-5 rounded-full bg-lp-text-2" />
                      This week
                    </span>
                  </span>
                </motion.div>
              </div>

              <ul className="mt-4 grid gap-3 md:mt-5 md:gap-4 lg:grid-cols-3">
                {SIGNALS.map((signal, i) => (
                  <SignalCard key={signal.title} signal={signal} index={i} revealed={phase >= PHASE.final} instant={instant} />
                ))}
              </ul>
            </div>
          </div>

          {/* Same three columns and inner padding as the cards above, so the edges line up. */}
          <div className="mt-8 grid gap-8 md:mt-10 md:px-7 lg:grid-cols-3 lg:gap-4">
            <p className="max-w-[440px] text-[14.5px] leading-relaxed text-lp-muted lg:pr-6">
              Illustrative. bizinsights&apos; highlights answer questions like these in plain sentences on your dashboard.
            </p>
            <div className="lg:col-span-2">
              <p id="ask-insight-prompts" className="lp-eyebrow">
                Questions like these
              </p>
              <ul aria-labelledby="ask-insight-prompts" className="mt-4 flex flex-col gap-2.5">
                {PROMPTS.map((prompt, i) => {
                  const active = i === highlight;
                  return (
                    <li
                      key={prompt}
                      className={`flex items-center gap-2.5 text-[15px] transition-colors duration-700 ease-lp ${active ? "text-lp-text" : "text-lp-text-2"}`}
                    >
                      <span
                        aria-hidden
                        className={`size-1.5 shrink-0 rounded-full transition-all duration-700 ease-lp ${
                          active ? "scale-125 bg-lp-violet-bright" : "bg-lp-line-strong"
                        }`}
                      />
                      {prompt}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

/** The question typing itself. An invisible full copy holds the final size, so nothing reflows. */
function QueryText({ run, complete, onDone }: { run: boolean; complete: boolean; onDone: () => void }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!run) return;
    if (count >= QUERY.length) {
      const id = window.setTimeout(onDone, 320);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(() => setCount((c) => c + 1), KEY_DELAYS[count]);
    return () => window.clearTimeout(id);
  }, [run, count, onDone]);

  const text = complete ? QUERY : QUERY.slice(0, count);
  const idle = !run && !complete;

  return (
    <div className="relative grid min-w-0 flex-1 text-[17px] font-medium leading-snug tracking-[-0.015em] md:text-[22px] xl:text-[26px]">
      <span className="invisible col-start-1 row-start-1">
        {QUERY}
        <span className="ml-[2px] inline-block w-[2px]" />
      </span>
      <span className="col-start-1 row-start-1 text-lp-text">
        {idle ? <span className="text-lp-muted">Ask about your store</span> : text}
        {!complete && (
          <span className="lp-loop lp-blink ml-[2px] inline-block h-[1.05em] w-[2px] translate-y-[0.17em] rounded-full bg-lp-violet-bright" />
        )}
      </span>
    </div>
  );
}

function AnalysisRow({ topic, state, instant }: { topic: string; state: RowState; instant: boolean }) {
  return (
    <li
      className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors sm:gap-3 sm:px-3.5 sm:py-3 duration-500 ${
        state === "waiting" ? "border-lp-line bg-white/[0.01]" : "border-lp-line-strong bg-white/[0.025]"
      }`}
    >
      <span className="relative grid size-5 shrink-0 place-items-center">
        {state === "waiting" && <span className="size-4 rounded-full border border-lp-line-strong" />}
        {state === "active" && (
          <motion.span
            animate={{ rotate: 360 }}
            transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
            className="size-4 rounded-full border-2 border-lp-violet/25 border-t-lp-violet-bright"
          />
        )}
        {state === "done" && (
          <motion.span
            initial={instant ? false : { scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="grid size-5 place-items-center rounded-full bg-lp-positive/15"
          >
            <Check className="size-3 text-lp-positive" strokeWidth={3} />
          </motion.span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13.5px] transition-colors duration-500 ${state === "waiting" ? "text-lp-muted" : "text-lp-text-2"}`}>
          <span className="max-sm:hidden">Analyzing </span>
          <span className="max-sm:capitalize">{topic}…</span>
        </span>
        <span className="relative mt-2 block h-[3px] overflow-hidden rounded-full bg-lp-line">
          <motion.span
            initial={false}
            animate={{ scaleX: state === "waiting" ? 0 : state === "active" ? 0.86 : 1, opacity: state === "done" ? 0.5 : 1 }}
            transition={instant ? { duration: 0 } : { duration: state === "active" ? 1.2 : 0.5, ease: EASE }}
            className="absolute inset-0 origin-left rounded-full [background:var(--lp-gradient)]"
          />
          {state === "active" && (
            <motion.span
              initial={{ x: "-120%" }}
              animate={{ x: "330%" }}
              transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }}
              className="absolute inset-y-0 left-0 w-1/3 [background:linear-gradient(90deg,transparent,rgb(255_255_255/0.6),transparent)]"
            />
          )}
        </span>
      </span>
    </li>
  );
}

function SignalCard({ signal, index, revealed, instant }: { signal: Signal; index: number; revealed: boolean; instant: boolean }) {
  const Icon = signal.icon;
  const delay = instant ? 0 : index * 0.14;
  // The content starts once the skeleton has gone, so the two never print over each other.
  const ease = instant ? { duration: 0 } : { duration: 0.8, ease: EASE, delay: delay + 0.18 };

  return (
    <li
      className={`relative overflow-hidden rounded-2xl border p-5 transition-colors duration-700 md:p-6 ${
        revealed ? "border-lp-line-strong bg-white/[0.03]" : "border-dashed border-lp-line bg-transparent"
      }`}
    >
      {/* Skeleton shown while the answer is still being worked out; it mirrors the card's layout. */}
      <motion.div
        initial={false}
        animate={{ opacity: revealed ? 0 : 1 }}
        transition={instant ? { duration: 0 } : { duration: 0.22, ease: "linear", delay }}
        className="pointer-events-none absolute inset-5 flex flex-col justify-between gap-6 md:inset-6 sm:max-lg:flex-row sm:max-lg:gap-10"
      >
        <span className="flex flex-col gap-3 sm:max-lg:flex-1">
          <span className="flex items-center gap-2.5">
            <span className="size-8 rounded-lg bg-white/[0.04]" />
            <span className="h-2.5 w-20 rounded-full bg-white/[0.05]" />
          </span>
          <span className="mt-2 h-2.5 w-full rounded-full bg-white/[0.04]" />
          <span className="h-2.5 w-3/4 rounded-full bg-white/[0.04]" />
        </span>
        <span className="flex flex-col gap-5 sm:max-lg:flex-1 sm:max-lg:justify-center">
          {[0.42, 0.58].map((w) => (
            <span key={w} className="flex flex-col gap-2">
              <span className="h-2 w-2/5 rounded-full bg-white/[0.04]" />
              <span className="h-[3px] rounded-full bg-white/[0.04]" style={{ width: `${w * 100}%` }} />
            </span>
          ))}
        </span>
      </motion.div>

      <motion.div
        initial={false}
        animate={revealed ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
        transition={ease}
        className="flex h-full flex-col sm:max-lg:grid sm:max-lg:grid-cols-2 sm:max-lg:items-center sm:max-lg:gap-10"
      >
        <div className="pb-5 sm:max-lg:pb-0">
          <div className="flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2.5 text-[15px] font-medium text-lp-text">
              <span className="grid size-8 place-items-center rounded-lg border border-lp-line-strong bg-lp-elevated">
                <Icon className="size-4 text-lp-violet-bright" strokeWidth={1.8} />
              </span>
              {signal.title}
            </h3>
            <span className="font-lp-mono text-[11px] tracking-[0.12em] text-lp-muted">0{index + 1}</span>
          </div>
          <p className="mt-4 text-[15px] leading-relaxed text-pretty text-lp-text-2 lg:min-h-[3.25em]">{signal.text}</p>
        </div>

        <div className="mt-auto flex flex-col gap-4 border-t border-lp-line pt-5 sm:max-lg:border-t-0 sm:max-lg:pt-0">
          {signal.metrics.map((m) => {
            const dir = DIRECTION[m.direction];
            const DirIcon = dir.icon;
            return (
              <div key={m.label}>
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-[12.5px] text-lp-text-2">{m.label}</p>
                  <span className={`flex shrink-0 items-center gap-1 font-lp-mono text-[10.5px] uppercase tracking-[0.12em] ${TONE_TEXT[m.tone]}`}>
                    <DirIcon aria-hidden className="size-3" strokeWidth={2.2} />
                    {dir.word}
                  </span>
                </div>
                <div className="mt-2 flex flex-col gap-1.5">
                  <motion.span
                    initial={false}
                    animate={{ scaleX: revealed ? m.prev : 0 }}
                    transition={instant ? { duration: 0 } : { duration: 1, ease: EASE, delay: delay + 0.36 }}
                    className="block h-[3px] origin-left rounded-full bg-lp-line-strong"
                  />
                  <motion.span
                    initial={false}
                    animate={{ scaleX: revealed ? m.now : 0 }}
                    transition={instant ? { duration: 0 } : { duration: 1.1, ease: EASE, delay: delay + 0.48 }}
                    className={`block h-[5px] origin-left rounded-full ${TONE_BG[m.tone]}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </motion.div>
    </li>
  );
}

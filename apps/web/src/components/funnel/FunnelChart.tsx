"use client";
import { ArrowDown, ChevronRight, TriangleAlert } from "lucide-react";
import { largestDropOff } from "@app/shared/funnel";
import { FUNNEL_STEPS } from "@app/shared/journey";
import type { FunnelStep } from "@app/shared/journey";
import type { FunnelPageModule } from "@/components/dashboard/types";
import { fmtNum, fmtPct } from "@/lib/api";
import { FunnelSection } from "./FunnelUi";
import { STAGES } from "./stageGuide";

/** How dark each stage's bar is: the same colour, lighter as visits go further. */
const SHADE = ["bg-accent", "bg-accent/85", "bg-accent/70", "bg-accent/60", "bg-accent/50"];

/**
 * The funnel itself: each stage a bar as wide as its share of visits, the visits that went on and
 * the visits lost between each pair, the largest drop-off marked in words, and every stage opening
 * its explanation. Every stage counts the same visits, so the bars narrow by what happened, never by
 * design.
 */
export function FunnelChart({ f, onOpen }: { f: FunnelPageModule; onOpen: (step: FunnelStep) => void }) {
  const worst = largestDropOff(f.transitions);
  return (
    <FunnelSection
      id="stages"
      title="Customer journey"
      sub="How far each tracked visit got, from arriving to buying. A visit counts at every stage up to the furthest one it reached. Select a stage to see what it means and what you can do about it."
    >
      <ol aria-label="Funnel stages" className="mx-auto max-w-4xl">
        {FUNNEL_STEPS.map((step, k) => {
          const s = f.steps[k]!;
          const share = s.shareOfVisits ?? 0;
          const t = f.transitions[k];
          const g = STAGES[step];
          return (
            <li key={step}>
              <button
                type="button"
                onClick={() => onOpen(step)}
                className="group grid w-full grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-xl p-2 text-left transition hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:p-3"
                data-testid={`funnel-stage-${step}`}
              >
                <span aria-hidden className={`mt-0.5 grid size-8 place-items-center rounded-full text-sm font-semibold ${k === 4 ? "bg-accent text-accent-ink" : "border border-border bg-surface"}`}>
                  {k + 1}
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="flex items-center gap-1 font-semibold">
                      {g.name}
                      <ChevronRight aria-hidden className="h-4 w-4 text-muted transition group-hover:translate-x-0.5" />
                    </span>
                    <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <strong className="text-lg tabular-nums">{fmtNum(s.reached)}</strong>
                      <span className="text-muted">visits · {fmtPct(share)} of all visits</span>
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">{g.short}</span>
                  <span className="mt-2 block h-9 rounded-lg bg-bg sm:h-10" aria-hidden>
                    <span className={`animate-grow-x mx-auto block h-full rounded-lg ${SHADE[k]} transition-[width] duration-700`} style={{ width: `${share * 100}%`, minWidth: s.reached > 0 ? 8 : 0 }} />
                  </span>
                </span>
              </button>
              {t && (
                <div className="ml-[2.75rem] flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-dashed border-border py-2 pl-4 text-sm sm:ml-[3.25rem]" data-testid={`funnel-transition-${t.from}`}>
                  <ArrowDown aria-hidden className="h-4 w-4 shrink-0 text-muted" />
                  <span>
                    <strong className="tabular-nums">{fmtPct(t.progression)}</strong> {STAGES[t.to].wentOn}
                  </span>
                  <span className="text-muted" aria-hidden>
                    ·
                  </span>
                  <span className={worst === k ? "font-medium text-danger" : "text-muted"}>
                    {fmtNum(t.lost)} {t.lost === 1 ? "visit" : "visits"} didn&apos;t ({fmtPct(t.dropOff)} drop-off)
                  </span>
                  {worst === k && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-danger/40 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
                      <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
                      Largest drop-off
                    </span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </FunnelSection>
  );
}

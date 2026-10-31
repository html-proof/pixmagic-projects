"use client";
import { TriangleAlert } from "lucide-react";
import { largestDropOff, type FunnelTransition } from "@app/shared/funnel";
import type { FunnelPageModule } from "@/components/dashboard/types";
import { fmtNum, fmtPct } from "@/lib/api";
import { fmtPts, FunnelSection, InfoTip } from "./FunnelUi";
import { FORMULAS, STAGES } from "./stageGuide";

/** The change in a transition's progression against the dates compared with, and whether it is more than chance. */
function Change({ t }: { t: FunnelTransition }) {
  if (!t.previous) return <span className="text-xs text-muted">No earlier data</span>;
  if (t.change === null) return <span className="text-xs text-muted">No visits to compare</span>;
  const tone = !t.significant || t.change === 0 ? "text-muted" : t.change > 0 ? "text-good" : "text-danger";
  return (
    <span className="flex flex-col">
      <span className={`text-sm font-medium tabular-nums ${tone}`}>{fmtPts(t.change)}</span>
      <span className="text-[11px] text-muted">
        was {fmtPct(t.previous.progression)} · {t.significant ? "a clear change" : "within normal variation"}
      </span>
    </span>
  );
}

/** What one transition's result means, in a sentence. */
function meaning(t: FunnelTransition): string {
  if (!t.fromCount) return `No visits reached "${STAGES[t.from].name.toLowerCase()}" in these dates.`;
  const lost = `${fmtNum(t.lost)} of ${fmtNum(t.fromCount)} visits stopped at "${STAGES[t.from].name.toLowerCase()}" and never ${STAGES[t.to].wentOn.replace(/^went on to /, "")}`;
  if (!t.previous || t.change === null || !t.significant) return `${lost}.`;
  return `${lost}; a ${t.change > 0 ? "larger" : "smaller"} share went on than in the dates compared with.`;
}

/**
 * "Where you lose potential customers": every step to the next, with the visits at each, the visits
 * lost, the drop-off and progression rates and their change, the largest drop-off marked in words.
 * One set of visits throughout, so the counts are exact, not approximations from two sources.
 */
export function DropOffs({ f }: { f: FunnelPageModule }) {
  const worst = largestDropOff(f.transitions);
  const tip = (
    <InfoTip label="How drop-off is calculated">
      <p>Progression rate = {FORMULAS.progression}.</p>
      <p className="mt-1">Drop-off rate = {FORMULAS.dropOff}.</p>
      <p className="mt-1">Overall conversion rate = {FORMULAS.conversion}.</p>
      <p className="mt-1 text-muted">A change is called clear when a two-proportion test says it is larger than chance would explain (95%), with at least 30 visits on each side.</p>
    </InfoTip>
  );
  return (
    <FunnelSection id="drop-offs" title="Where you lose potential customers" sub="Each step to the next: how many visits went on, how many didn't, and how that compares with the dates before." aside={tip}>
      {/* Phones: one card per step. */}
      <ul className="space-y-3 md:hidden">
        {f.transitions.map((t, i) => (
          <li key={t.from} className={`rounded-xl border p-3 ${worst === i ? "border-danger/40 bg-danger/5" : "border-border"}`}>
            <p className="text-sm font-medium">
              {STAGES[t.from].name} → {STAGES[t.to].name}
            </p>
            {worst === i && (
              <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-danger">
                <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
                Largest drop-off
              </p>
            )}
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <div><dt className="text-xs text-muted">Reached the step</dt><dd className="tabular-nums">{fmtNum(t.fromCount)}</dd></div>
              <div><dt className="text-xs text-muted">Went on</dt><dd className="tabular-nums">{fmtNum(t.toCount)} ({fmtPct(t.progression)})</dd></div>
              <div><dt className="text-xs text-muted">Lost</dt><dd className="tabular-nums">{fmtNum(t.lost)} ({fmtPct(t.dropOff)})</dd></div>
              <div><dt className="text-xs text-muted">Progression change</dt><dd><Change t={t} /></dd></div>
            </dl>
            <p className="mt-2 text-xs text-muted">{meaning(t)}</p>
          </li>
        ))}
      </ul>
      <div className="-mx-1 hidden overflow-x-auto md:block">
        <table className="w-full min-w-[52rem] text-sm" data-testid="funnel-drop-off-table">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="px-2 pb-2 font-normal">Step</th>
              <th className="px-2 pb-2 text-right font-normal">Reached the step</th>
              <th className="px-2 pb-2 text-right font-normal">Went on</th>
              <th className="px-2 pb-2 text-right font-normal">Lost</th>
              <th className="px-2 pb-2 text-right font-normal">Drop-off</th>
              <th className="px-2 pb-2 text-right font-normal">Progression</th>
              <th className="px-2 pb-2 font-normal">Against the dates compared with</th>
              <th className="px-2 pb-2 font-normal">What it means</th>
            </tr>
          </thead>
          <tbody>
            {f.transitions.map((t, i) => (
              <tr key={t.from} className={`border-t border-border align-top ${worst === i ? "bg-danger/5" : ""}`} data-testid={`funnel-drop-${t.from}`}>
                <td className="px-2 py-2.5">
                  <span className="font-medium">
                    {STAGES[t.from].name} → {STAGES[t.to].name}
                  </span>
                  {worst === i && (
                    <span className="mt-1 flex items-center gap-1 text-xs font-medium text-danger">
                      <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
                      Largest drop-off
                    </span>
                  )}
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums">{fmtNum(t.fromCount)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">{fmtNum(t.toCount)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">{fmtNum(t.lost)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">
                  <span className="flex items-center justify-end gap-2">
                    <span aria-hidden className="hidden h-1.5 w-16 rounded-full bg-bg lg:block">
                      <span className="block h-1.5 rounded-full bg-danger/60" style={{ width: `${(t.dropOff ?? 0) * 100}%` }} />
                    </span>
                    {fmtPct(t.dropOff)}
                  </span>
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums">{fmtPct(t.progression)}</td>
                <td className="px-2 py-2.5"><Change t={t} /></td>
                <td className="max-w-[18rem] px-2 py-2.5 text-xs text-muted">{meaning(t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">
        Overall: <strong className="text-text">{fmtPct(f.conversionRate)}</strong> of visits ended in a purchase ({fmtNum(f.purchases)} of {fmtNum(f.visits)}). Rates aren&apos;t judged good or bad here: compare them with your own earlier dates.
      </p>
    </FunnelSection>
  );
}

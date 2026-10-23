import type { CSSProperties, ReactNode } from "react";
import { ArrowRight, Check, CircleAlert, CircleCheck, CircleDashed, LoaderCircle } from "lucide-react";
import type { AdPlatformInfo, ChipTone } from "@/components/integrations/adPlatforms";
import { stateInfo, type AdState, type StateTone } from "@/lib/adConnections";

// ---------------------------------------------------------------------------
// The pieces Settings → Advertising's cards are drawn with: a colour as `--tone` (the tone-*
// utilities in globals.css read it), the state pill, the platform's logo tile, the row of what
// bizinsights reads, ticked lists and label/value rows.
// ---------------------------------------------------------------------------

/** Style that sets a block's `--tone`. */
export const tone = (color: string): CSSProperties => ({ ["--tone" as string]: color });

const CHIP_COLOR: Record<ChipTone, string> = { info: "var(--info)", violet: "var(--violet)", good: "var(--good)", orange: "var(--accent-2)", rose: "var(--rose)" };

/** A state's colour: the label always says it, the colour only backs it up. */
export const STATE_COLOR: Record<StateTone, string> = { good: "var(--good)", warn: "var(--warn)", danger: "var(--danger)", neutral: "var(--muted)" };

/** A connection's (or a platform's) state as a tinted pill with its icon; a demo's named as such ("Demo connected"). */
export function StatePill({ state, demo = false, testid }: { state: AdState; demo?: boolean; testid?: string }) {
  const s = stateInfo(state, demo);
  const Glyph = s.busy ? LoaderCircle : s.tone === "good" ? CircleCheck : s.tone === "neutral" ? CircleDashed : CircleAlert;
  return (
    <span className="tone-pill px-2.5 py-1 text-[0.8125rem]" style={tone(STATE_COLOR[s.tone])} data-testid={testid} data-state={state}>
      <Glyph size={14} strokeWidth={2.2} aria-hidden className={s.busy ? "motion-safe:animate-spin" : undefined} />
      {s.label}
    </span>
  );
}

/** The platform's mark on a white tile, as on its own pages. */
export function LogoTile({ P, size = "md" }: { P: AdPlatformInfo; size?: "md" | "lg" }) {
  const box = size === "lg" ? "size-16 rounded-2xl" : "size-14 rounded-xl";
  return (
    <span className={`grid shrink-0 place-items-center border border-border bg-white shadow-[var(--shadow)] ${box}`} aria-hidden>
      <P.Icon size={size === "lg" ? 34 : 30} />
    </span>
  );
}

/** What bizinsights reads from a platform, in the order the platform nests it: coloured chips joined by arrows. */
export function ReadsFlow({ P }: { P: AdPlatformInfo }) {
  return (
    <ol aria-label={`What bizinsights reads from ${P.name}`} className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
      {P.reads.map(({ label, icon: Glyph, tone: t }, i) => (
        <li key={label} className="flex items-center gap-1.5">
          {/* Not on a phone, where the chips wrap and an arrow would start a line. */}
          {i > 0 && <ArrowRight size={13} aria-hidden className="shrink-0 text-muted max-sm:hidden" />}
          <span className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg/50 py-1.5 pl-1.5 pr-3 text-sm font-medium" style={tone(CHIP_COLOR[t])}>
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-[var(--tone)] text-[var(--surface)]" aria-hidden>
              <Glyph size={15} strokeWidth={2} />
            </span>
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A green tick in a disc, for lists of what something brings. */
export function Tick() {
  return (
    <span className="mt-px grid size-[1.125rem] shrink-0 place-items-center rounded-full bg-good text-[var(--surface)]" aria-hidden>
      <Check size={11} strokeWidth={3.2} />
    </span>
  );
}

/** A small heading inside a card's panel. */
export function PanelTitle({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="text-sm font-semibold">
      {children}
    </h3>
  );
}

/** Label and value rows, the label on the left. Values wrap: a long one is read in full, never cut off. */
export function Rows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

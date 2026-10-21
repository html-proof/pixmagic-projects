import { fmtDay } from "./format";
import type { AdFigures } from "./types";

// ---------------------------------------------------------------------------
// Which ads or AdSense figures to show for the dates picked, for every card, panel and summary line
// alike. Pure: no components, so the topic summaries can use it too.
// ---------------------------------------------------------------------------

/**
 * The figures to show for the dates: the whole range's, or, while the only days missing are ones
 * not over yet (`soFar`: an account's running day before its next sync, or a store day it hasn't
 * reached in its own time zone), the days so far, `through` their last day. Null totals: "Unavailable".
 */
export function shownFigures<T>(fig: Pick<AdFigures<T>, "current" | "soFar">): { totals: T | null; through: string | null } {
  if (fig.current) return { totals: fig.current, through: null };
  if (fig.soFar) return { totals: fig.soFar.totals, through: fig.soFar.to };
  return { totals: null, through: null };
}

/** "up to 18 Oct", for figures of the dates so far. */
export const upToWords = (through: string) => `up to ${fmtDay(through, { year: false })}`;

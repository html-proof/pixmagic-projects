/**
 * Shopify's own abandoned checkouts on the Shopping Funnel page (../shopifyCheckouts.ts for where
 * they come from): how many there were, their value, how many were recovered and the recovered
 * rate, for the dates and what they are compared with.
 *
 * Nothing here calls Shopify. As with Shopify's other report figures (./shopify.ts), the route reads
 * what the worker keeps and queues what is missing or stale (`refresh`); while the range runs, both
 * windows stop at the same 5-minute mark (like for like). A window Shopify doesn't share (created
 * more than 60 days ago, without read_all_orders) is never asked for: it says so instead of a number.
 */
import type { Store, Tx } from "@app/db";
import { delta, expandScopes, type Comparison, type DateRange } from "@app/shared";
import { checkoutsVisible, checkoutValuesOf, firstVisibleDay, type CheckoutValues } from "../shopifyCheckouts.js";
import { keptReports, type ReportRequest, type ReportWindow } from "../shopifyReports.js";
import { answerOf, keptAnswers, pickAnswers, reportStale, reportWindows, type ReportStatus } from "./shopify.js";

const DATASET = "abandoned_checkouts";

/** Why a window has no figures (ReportStatus), or that Shopify doesn't share checkouts that old. */
export type CheckoutsStatus = ReportStatus | "beyond_history";

export interface CheckoutFigures extends CheckoutValues {
  /** Recovered ÷ abandoned, by the day each checkout was created; null with none, or with a count that is only a lower bound. */
  recoveredRate: number | null;
}

export interface AbandonedCheckoutsModule {
  status: CheckoutsStatus;
  /** The comparison's own: it can be older than Shopify shares while the range isn't. */
  previousStatus: CheckoutsStatus;
  /** When Shopify was asked for the range's figures. */
  asOf: string | null;
  /** Store-local time both windows stop at while the range runs; null for whole days. */
  until: string | null;
  /** The first day Shopify shares checkouts for (null: the store granted read_all_orders). */
  visibleFrom: string | null;
  current: CheckoutFigures | null;
  /** The comparison's figures (without the days). */
  previous: Omit<CheckoutFigures, "days"> | null;
  deltas: { abandoned: number | null; value: number | null; recoveredRate: number | null };
}

function figures(x: CheckoutValues | null): CheckoutFigures | null {
  if (!x) return null;
  const exact = x.abandonedExact && x.recoveredExact;
  return { ...x, recoveredRate: exact && x.abandoned > 0 ? x.recovered / x.abandoned : null };
}

function withoutDays({ days: _days, ...rest }: CheckoutFigures): Omit<CheckoutFigures, "days"> {
  return rest;
}

/**
 * The module for one store and dates, and the windows to fetch again. `store.grantedScopes` decides
 * how far back Shopify shares checkouts; the route has already checked the store may be read
 * (`abandoned_checkouts` capability) and the member may see it (`analytics.abandonment`).
 */
export async function abandonedCheckoutsModule(
  tx: Tx,
  store: Pick<Store, "id" | "workspaceId" | "grantedScopes">,
  dates: { range: DateRange; previous: Comparison },
  ctx: { today: string; now: Date },
): Promise<{ module: AbandonedCheckoutsModule; refresh: ReportRequest[] }> {
  const w = reportWindows(dates.range, dates.previous);
  const visible = { current: checkoutsVisible(store, w.current, ctx.today), previous: checkoutsVisible(store, w.previous, ctx.today) };
  const wins: ReportWindow[] = [...(visible.current ? [w.current] : []), ...(visible.previous ? [w.previous] : [])];
  // A kept answer that isn't this dataset's shape (kept before a figure was added) counts as missing: it is asked for again.
  const kept = (await keptReports(tx, store, wins)).filter((k) => k.dataset === DATASET && (k.values === null || checkoutValuesOf(k.values) !== null));
  const stale = keptAnswers(kept, DATASET, wins).map((k, i) => reportStale(k, wins[i]!, ctx.today, ctx.now));
  const refresh: ReportRequest[] = wins.filter((_, i) => stale[i]).map((win) => ({ dataset: DATASET, window: win }));

  const picked = pickAnswers(kept, DATASET, wins);
  const answer = (win: ReportWindow, shared: boolean) => {
    if (!shared) return { status: "beyond_history" as const, values: null, fetchedAt: null };
    const a = answerOf(picked.reports[wins.indexOf(win)]);
    return { ...a, values: a.values ? checkoutValuesOf(a.values) : null };
  };
  const now = answer(w.current, visible.current);
  const before = answer(w.previous, visible.previous);
  const cur = figures(now.values);
  const prev = figures(before.values);
  // A count Shopify gives only as a lower bound has no exact change.
  const abandonedChange = cur && prev && cur.abandonedExact && prev.abandonedExact ? delta(cur.abandoned, prev.abandoned) : null;
  return {
    module: {
      status: now.status,
      previousStatus: before.status,
      asOf: now.fetchedAt ? now.fetchedAt.toISOString() : null,
      until: picked.until,
      visibleFrom: expandScopes(store.grantedScopes).has("read_all_orders") ? null : firstVisibleDay(ctx.today),
      current: cur,
      previous: prev ? withoutDays(prev) : null,
      deltas: {
        abandoned: abandonedChange,
        value: delta(cur?.value ?? null, prev?.value ?? null),
        recoveredRate: delta(cur?.recoveredRate ?? null, prev?.recoveredRate ?? null),
      },
    },
    refresh,
  };
}

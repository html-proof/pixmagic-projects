/**
 * Shared pieces of the dashboard's report queries (see ./overview.ts).
 *
 * Every query filters on workspace_id AND store_id (RLS is the backstop, not the filter), uses
 * bound parameters only, and excludes cancelled orders unless the module says otherwise. Money
 * comes back from SQL as text (exact decimals) and is converted with Number at the edge.
 */

/** Tenant + store being reported on. */
export interface Scope {
  ws: string;
  storeId: string;
}

export const r1 = (n: number) => Math.round(n * 10) / 10;
export const r2 = (n: number) => Math.round(n * 100) / 100;
export const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Index of the largest value, or null when everything is zero. First wins on ties. */
export function argMax(values: number[]): number | null {
  let best: number | null = null;
  values.forEach((v, i) => {
    if (v > 0 && (best === null || v > values[best]!)) best = i;
  });
  return best;
}

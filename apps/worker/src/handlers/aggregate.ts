/** The aggregate queue: daily store metrics recomputed, and the days that failed remembered for the reconcile sweep. */
import { systemDb } from "@app/db";
import { recomputeDays, type AggregateJobData } from "@app/core";
import type { WorkerDeps } from "./common.js";

export async function runAggregate(data: AggregateJobData) {
  const store = await systemDb.store.findUnique({ where: { id: data.storeId }, select: { id: true, workspaceId: true } });
  if (!store) return { skipped: true };
  await recomputeDays(store, data.days);
  return { ok: true, days: data.days.length };
}

/** Days whose recompute gave up, per store, kept in the Coordinator for the next reconcile. */
export const failedAggregateKey = (storeId: string) => `agg-failed:${storeId}`;
export const FAILED_AGGREGATE_TTL_S = 14 * 86400;
/** More than a backfill's worth of days is never needed: the oldest are dropped. */
const FAILED_AGGREGATE_MAX_DAYS = 400;

/**
 * Remember the days of an aggregate job that has run out of attempts. The reconcile repairs days
 * with no totals at all (see unaggregatedDays), but a day whose recompute failed keeps its old,
 * now wrong, totals and would never be looked at again; the next reconcile recomputes these too.
 */
export async function rememberFailedAggregate(deps: Pick<WorkerDeps, "coord">, data: AggregateJobData) {
  const key = failedAggregateKey(data.storeId);
  const prev = await deps.coord.take(key);
  const days = [...new Set([...(prev ? (JSON.parse(prev) as string[]) : []), ...data.days])].sort().slice(-FAILED_AGGREGATE_MAX_DAYS);
  await deps.coord.put(key, JSON.stringify(days), FAILED_AGGREGATE_TTL_S);
}

/**
 * Zapier (docs/zapier.md): one delivery of the outbox to a Zap's trigger (`kind: "zapier"` on the
 * sync queue), and the cron's part. The delivery rows carry their own attempts, backoff and outcome,
 * so a delivery never throws for Zapier's answer: like texts, nothing here is left to the queue's
 * own retries.
 */
import { deliverZapier, sweepZapier, type ZapierJob } from "@app/core/zapier";
import type { WorkerDeps } from "./common.js";

export async function runZapierJob(job: ZapierJob, deps: WorkerDeps) {
  return { outcome: await deliverZapier(job.deliveryId, deps) };
}

/** Last in the cron tick: alerts the sweeps before it raised go out in the same tick. */
export async function sweepZapierDeliveries(deps: WorkerDeps) {
  return sweepZapier(deps);
}

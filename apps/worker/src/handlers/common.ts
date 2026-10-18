/** What every queue handler shares: its dependencies, the errors that end retries, and asking for days to be re-aggregated. */
import type { BlobStore, Coord, FetchLike, Mailer, Queues, SmtpConnect } from "@app/core";

export interface WorkerDeps {
  coord: Coord;
  queues: Queues;
  payloads: BlobStore;
  mailer: Mailer;
  fetchImpl: FetchLike;
  /** Outbound TCP for SMTP email accounts (apps/aws/src/nodeSmtp.ts). Absent: SMTP accounts can't send. */
  smtpConnect?: SmtpConnect;
}

/** Thrown when retrying cannot help (store disconnected, access revoked). The job fails immediately. */
export class UnrecoverableError extends Error {
  override name = "UnrecoverableError";
}

/**
 * Shopify no longer accepts our credentials for the store (401/403, or no token at all): every
 * job for it will fail the same way until the merchant reconnects, whatever kind it is.
 */
export class AccessRevokedError extends UnrecoverableError {
  // Keeps the parent's `name`: logs and callers that match on "UnrecoverableError" still see one.
}

export async function enqueueAggregate(deps: WorkerDeps, storeId: string, days: Iterable<string>) {
  const list = [...new Set(days)].sort();
  for (let i = 0; i < list.length; i += 31) {
    const chunk = list.slice(i, i + 31);
    await deps.queues.aggregate.send({ storeId, days: chunk });
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

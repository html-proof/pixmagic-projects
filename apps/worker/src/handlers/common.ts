/** What every queue handler shares: its dependencies, the errors that end retries, and asking for days to be re-aggregated. */
import type { BlobStore, Coord, FetchLike, Mailer, Queues, SmtpConnect } from "@app/core";
import type { SmsProvider } from "@app/core/sms";

export interface WorkerDeps {
  coord: Coord;
  queues: Queues;
  payloads: BlobStore;
  mailer: Mailer;
  fetchImpl: FetchLike;
  /** Outbound TCP for SMTP email accounts (apps/aws/src/nodeSmtp.ts). Absent: SMTP accounts can't send. */
  smtpConnect?: SmtpConnect;
  /** AWS End User Messaging SMS (apps/aws/src/smsProvider.ts). Absent: nothing can be texted. */
  sms?: SmsProvider;
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

/**
 * Shopify won't let the app read protected customer data (orders among it) on this store until it
 * approves the app's access request: every orders job fails the same way until then, and nothing
 * the merchant does changes that, reconnecting included. Shopify's App Review stores are exempt, so
 * a store it reviews with imports while a merchant's store doesn't (production, 2026-10-18).
 */
export class NotApprovedError extends UnrecoverableError {
  // Keeps the parent's `name`, as AccessRevokedError does.
}

export async function enqueueAggregate(deps: WorkerDeps, storeId: string, days: Iterable<string>) {
  const list = [...new Set(days)].sort();
  for (let i = 0; i < list.length; i += 31) {
    const chunk = list.slice(i, i + 31);
    await deps.queues.aggregate.send({ storeId, days: chunk });
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

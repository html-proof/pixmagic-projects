import { dbReachable, systemDb, type StoreStatus } from "@app/db";
import {
  backoffSeconds,
  flagStaleSessions,
  logger,
  MAX_ATTEMPTS,
  pruneShopifyReports,
  pruneTeamRecords,
  raiseAlert,
  type AdsSyncData,
  type AggregateJobData,
  type Producer,
  type QueueName,
  sweepWhatsapp,
  sweepEmail,
  type EmailJob,
  type ShopifyReportsJob,
  type SyncJobData,
  type VerifyJob,
  type WebhookJobData,
  pruneReconciliations,
  failInventoryPass,
  type WhatsappJob,
} from "@app/core";
import {
  AccessRevokedError,
  NotApprovedError,
  failStaleJobs,
  processWebhook,
  pruneInventory,
  sweepInventory,
  refreshExpiringTokens,
  rememberFailedAggregate,
  runAdsSync,
  runAggregate,
  runEmailJob,
  runWhatsappJob,
  runSync,
  scheduleAdsSync,
  scheduleReconcile,
  seedSalesRereads,
  UnrecoverableError,
  type WorkerDeps,
} from "./handlers.js";
import { runShopifyReports } from "./shopifyReports.js";

import { failVerify, runVerify } from "./verify.js";

export * from "./handlers.js";
export { runVerify, startChecks } from "./verify.js";
export { runShopifyReports } from "./shopifyReports.js";

/** A queue message as the consumer sees it: SQS's (apps/aws/src/consumer.ts), the local queues', or a test's. */
export interface QueueMessage<T = unknown> {
  readonly id: string;
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ConsumeDeps extends WorkerDeps {
  /** Whether the database answers right now. Defaults to `dbReachable()`; tests inject an outage. */
  dbHealthy?: () => Promise<boolean>;
}

/**
 * Carried in the body of a message that was re-sent because the database was unreachable
 * (see deferForDb). It has to travel in the body: the re-send is a new message, so its
 * `attempts` starts again at 1.
 */
interface DbDeferral {
  /** Re-sends so far, for the backoff. */
  count: number;
  /** When the first one happened (epoch ms), for the give-up cap. */
  since: number;
}

/** Ceiling on the delay between re-sends while the database is unreachable. */
const DB_DEFER_MAX_DELAY_S = 300;
/**
 * How long a message keeps waiting for the database before it is let through to insights-dlq.
 * The database lives on a PC that can sleep for hours, so this is generous.
 */
const DB_DEFER_MAX_MS = 24 * 3600_000;

/**
 * Process one message. Success acks; failure retries with exponential backoff
 * until MAX_ATTEMPTS (or immediately fails on UnrecoverableError), then records
 * the failure and raises an alert. A failure while the database is unreachable
 * is not the job's fault and spends none of that budget (see deferForDb). Never
 * throws, so one bad message does not redeliver the rest of its batch.
 */
export async function consume(queue: QueueName, msg: QueueMessage, deps: ConsumeDeps): Promise<void> {
  // The deferral is consume's bookkeeping, not part of the job. Handlers re-enqueue
  // `{ ...data, ... }` (the next page, a halved page, the next bulk phase), so passing it through
  // would start every follow-up message part-way through an outage it never saw.
  const { dbDeferral, ...job } = (msg.body ?? {}) as { dbDeferral?: DbDeferral };
  // Ad platforms rate-limit per app: jitter keeps many accounts' retries from landing together.
  const jitter = queue === "sync" && (job as { kind?: string }).kind === "ads" ? Math.floor(Math.random() * 30) : 0;
  try {
    // Ad account syncs ride the sync queue too (see adsQueue), told apart by their kind.
    const kind = (job as { kind?: string }).kind;
    if (queue === "sync" && kind === "ads") await runAdsSync(job as AdsSyncData, deps);
    // WhatsApp messages ride the sync queue too; the message rows carry their own state.
    else if (queue === "sync" && (kind === "whatsapp" || kind === "whatsapp_dispatch")) await runWhatsappJob(job as WhatsappJob, deps);
    // The check against Shopify rides the sync queue too; its run's row is its record.
    else if (queue === "sync" && kind === "verify") await runVerify(job as VerifyJob, deps);
    // Shopify's report figures for the dashboard ride the sync queue too; the kept rows carry their state.
    else if (queue === "sync" && kind === "shopify_reports") await runShopifyReports(job as ShopifyReportsJob, deps);
    else if (queue === "sync") await runSync(job as SyncJobData, deps);
    else if (queue === "webhooks") await processWebhook(job as WebhookJobData, deps);
    else if (queue === "email") await runEmailJob(job as EmailJob, deps);
    else await runAggregate(job as AggregateJobData);
    msg.ack();
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (!(err instanceof UnrecoverableError) && !(await (deps.dbHealthy ?? dbReachable)())) {
      await deferForDb(queue, msg, job, dbDeferral, err, deps);
      return;
    }
    const final = err instanceof UnrecoverableError || msg.attempts >= MAX_ATTEMPTS;
    logger.error({ err, queue, messageId: msg.id, attempts: msg.attempts, final }, `${queue} job failed`);
    try {
      await onFailure(queue, job, err, final, deps);
    } catch (hookErr) {
      // Acking now would drop the message with nothing recorded: no failed row, no alert. Retry
      // instead - past the queue's maxReceiveCount SQS moves it to the dead-letter queue rather than deleting it.
      logger.error({ err: hookErr, queue }, "failure bookkeeping failed");
      msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
      return;
    }
    if (final) msg.ack();
    else msg.retry({ delaySeconds: backoffSeconds(msg.attempts) + jitter });
  }
}

/**
 * A job failed while the database was unreachable, so the failure says nothing about the job:
 * every handler starts with a database read, and a database outage can last minutes. Counted against MAX_ATTEMPTS, a 5-minute outage spent the whole budget (5+10+20+40+80s
 * of backoff) and onFailure could not record anything either, so the message was acked and lost.
 *
 * Instead the job is re-sent as a new message (the queue does not depend on the database), backing
 * off to every 5 minutes, and the original is acked only once the copy is enqueued. onFailure is
 * skipped: it could not write anyway. Past DB_DEFER_MAX_MS the message is retried normally
 * instead, so it ends up in the dead-letter queue rather than circling forever.
 */
async function deferForDb(queue: QueueName, msg: QueueMessage, job: object, prev: DbDeferral | undefined, err: Error, deps: WorkerDeps) {
  const now = Date.now();
  const since = prev?.since ?? now;
  const count = prev?.count ?? 0;
  const log = { err, queue, messageId: msg.id, attempts: msg.attempts, deferrals: count, deferredSince: new Date(since).toISOString() };
  if (now - since >= DB_DEFER_MAX_MS) {
    logger.error(log, `${queue} job gave up waiting for the database`);
    msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
    return;
  }
  const delaySeconds = Math.min(DB_DEFER_MAX_DELAY_S, 30 * 2 ** count);
  logger.warn({ ...log, delaySeconds }, `${queue} job deferred: database unreachable`);
  try {
    await (deps.queues[queue] as Producer<unknown>).send({ ...job, dbDeferral: { count: count + 1, since } }, { delaySeconds });
  } catch (sendErr) {
    logger.error({ err: sendErr, queue, messageId: msg.id }, "re-sending a deferred job failed");
    msg.retry({ delaySeconds: 60 });
    return;
  }
  msg.ack();
}

async function onFailure(queue: QueueName, body: unknown, err: Error, final: boolean, deps: WorkerDeps) {
  const error = err.message.slice(0, 500);
  const kind = (body as { kind?: string })?.kind;
  if (queue === "email") {
    // The message and event rows are the record: a send that keeps failing for infrastructure
    // reasons is put back by sendEmailMessage itself, and the sweep re-queues anything left waiting.
    return;
  }
  if (queue === "sync" && (kind === "whatsapp" || kind === "whatsapp_dispatch")) {
    // The message row is the record (scheduled / failed with its reason), and the sweeper picks up
    // anything still due. A dispatch chain that gave up lets the next tick start a new one.
    if (final && kind === "whatsapp_dispatch") await deps.coord.release(`wa-dispatch:${(body as { storeId: string }).storeId}`).catch(() => {});
    return;
  }
  if (queue === "sync" && kind === "verify") {
    if (final) await failVerify(body as VerifyJob, err);
    return;
  }
  if (queue === "sync" && kind === "shopify_reports") {
    // Nothing to mark: the dashboard asks again for whatever is still missing or stale.
    return;
  }
  if (queue === "sync" && (body as { kind?: string })?.kind === "ads") {
    // An ad account, not the store's import: never touches the store's status or raises a store
    // alert. Settings shows the account's own state (runAdsSync marks reconnect / error).
    if (final) {
      const data = body as AdsSyncData;
      await systemDb.adConnection
        .updateMany({ where: { id: data.connectionId, status: "active" }, data: { status: "error", lastError: error } })
        .catch(() => {});
    }
    return;
  }
  if (queue === "sync") {
    const data = body as SyncJobData;
    if (!data?.syncJobId) return;
    // Only a final failure settles the status; a retry is the same run carrying on. Rewriting it to
    // "queued" stranded it there: only a chain's first message marks the job running (later pages
    // carry a cursor), so if the chain then died the row looked like an import still waiting to
    // start, and kept its store "syncing" with nothing behind it.
    await systemDb.syncJob.update({ where: { id: data.syncJobId }, data: final ? { status: "failed", error } : { error } }).catch(() => {});
    if (!final) return;
    if (data.kind === "inventory") await failInventoryPass(data.inventory?.runId, error).catch(() => {});
    const store = await systemDb.store.findUnique({ where: { id: data.storeId } });
    if (!store || store.status === "uninstalled") return;
    // `error` means "this store's data has stopped": the dashboard offers Reconnect and stops
    // claiming an import is running. That is true when credentials are gone (every job fails), or
    // when the store's import was in progress and this was part of it. A catalog refresh, a daily
    // reconcile or a pixel install giving up on an otherwise healthy store is not that: flipping it
    // turned one Shopify 5xx streak into a "your store is broken" banner and a critical alert.
    // An inventory pass isn't part of the import either: its failure is its own alert.
    // Shopify not having approved the app for protected customer data stops every orders job too,
    // but nothing the merchant does fixes it: its own code (worded as such in @app/shared/alerts,
    // resolved by the next good run like a failure) and never critical.
    const notApproved = err instanceof NotApprovedError;
    const flippable: StoreStatus[] =
      err instanceof AccessRevokedError || notApproved ? ["active", "syncing"] : data.kind === "install_pixel" || data.kind === "inventory" ? [] : ["syncing"];
    const flipped = flippable.length
      ? await systemDb.store.updateMany({ where: { id: store.id, status: { in: flippable } }, data: { status: "error" } })
      : { count: 0 };
    await raiseAlert(
      {
        workspaceId: store.workspaceId,
        storeId: store.id,
        severity: !notApproved && (flipped.count || store.status === "error") ? "critical" : "warning",
        code: `sync_${data.kind}_${notApproved ? "not_approved" : "failed"}`,
        message: `We couldn't sync ${data.kind} for ${store.shopDomain}: ${err.message}`,
      },
      deps.mailer,
      deps.fetchImpl,
    );
  } else if (queue === "webhooks") {
    const data = body as WebhookJobData;
    await systemDb.webhookEvent.update({ where: { id: data.eventId }, data: { status: final ? "failed" : "queued", error } }).catch(() => {});
    if (!final) return;
    const ev = await systemDb.webhookEvent.findUnique({ where: { id: data.eventId } });
    if (ev?.workspaceId) {
      await raiseAlert(
        { workspaceId: ev.workspaceId, storeId: ev.storeId, severity: "warning", code: "webhook_failed", message: `Processing ${ev.topic} failed: ${err.message}` },
        deps.mailer,
        deps.fetchImpl,
      );
    }
    if (data.payloadKey) await deps.payloads.delete(data.payloadKey).catch(() => {});
  } else if (queue === "aggregate" && final) {
    // Those days keep totals that are now wrong: the next reconcile recomputes them.
    await rememberFailedAggregate(deps, body as AggregateJobData).catch((e: unknown) =>
      logger.error({ err: e, storeId: (body as AggregateJobData)?.storeId }, "could not record the days of a failed aggregate"),
    );
  }
}

/** Cron schedules (keep in sync with the EventBridge schedules in infra/cdk/lib/app-stack.ts). */
export const CRON = {
  reconcile: "15 3 * * *",
  refreshTokens: "*/15 * * * *",
} as const;

/**
 * The pixel's dedupe ids only matter while an event could still be accepted (production refuses
 * events older than two days), so older ones go, a bounded batch per tick. Without this the table
 * grew with every storefront event forever.
 */
const PIXEL_DEDUPE_KEEP_MS = 3 * 86_400_000;
export async function prunePixelDedupe(batch = 20_000): Promise<number> {
  const cutoff = new Date(Date.now() - PIXEL_DEDUPE_KEEP_MS);
  return systemDb.$executeRaw`
    DELETE FROM pixel_events_seen WHERE ctid IN (SELECT ctid FROM pixel_events_seen WHERE seen_at < ${cutoff} LIMIT ${batch})`;
}

/**
 * Team & Access retention (core's pruneTeamRecords) once a day, on whichever tick first gets the
 * day's lease: it scans the audit log, which no tick needs to do more often. A failed run gives the
 * lease back, so the next tick tries again.
 */
const TEAM_RETENTION_LEASE_MS = 23 * 3_600_000;
export async function pruneTeamDaily(deps: Pick<WorkerDeps, "coord">) {
  if (!(await deps.coord.acquire("sweep:team-retention", TEAM_RETENTION_LEASE_MS))) return null;
  try {
    return await pruneTeamRecords();
  } catch (err) {
    await deps.coord.release("sweep:team-retention").catch(() => {});
    throw err;
  }
}

export async function runScheduled(cron: string, deps: WorkerDeps) {
  if (cron === CRON.reconcile) return { reconciled: await scheduleReconcile(deps) };
  // Shares the */15 trigger rather than adding a schedule: both are cheap sweeps, and a stale
  // job only needs noticing within the window it has already been stuck for.
  if (cron === CRON.refreshTokens) {
    // Each sweep fails on its own: one that throws is logged and the rest still run this tick.
    const refreshed = await refreshExpiringTokens(deps).catch((err: unknown) => {
      logger.error({ err }, "token refresh sweep failed; the next tick tries again");
      return null;
    });
    const staleJobsFailed = await failStaleJobs(deps).catch((err: unknown) => {
      logger.error({ err }, "stale job sweep failed; the next tick tries again");
      return null;
    });
    // The reconcile rides on every tick too: run once at 03:15, a database that was unreachable
    // then (the PC asleep or offline, as it often is at that hour) skipped the day's safety net
    // with nothing to catch up, and in production it went four days without once getting through.
    // Per-store leases make this a no-op for stores already reconciled (see scheduleReconcile).
    // Last and on its own, so its failure holds up neither token refresh nor the reaper; the next
    // tick takes over.
    const reconciled = await scheduleReconcile(deps).catch((err: unknown) => {
      logger.error({ err }, "reconcile failed; the next tick picks up the stores it did not reach");
      return null;
    });
    // Orders whose sales records were never read (see seedSalesRereads); daily per store.
    const salesRereads = await seedSalesRereads(deps).catch((err: unknown) => {
      logger.error({ err }, "sales re-read sweep failed; the next tick tries again");
      return null;
    });
    // Ad accounts on their own leases, after everything the store itself depends on.
    const adsSynced = await scheduleAdsSync(deps).catch((err: unknown) => {
      logger.error({ err }, "ad sync scheduling failed; the next tick tries again");
      return null;
    });
    // WhatsApp: campaigns, due messages, parcel status, retention. Last, on its own leases.
    const whatsapp = await sweepWhatsapp(deps).catch((err: unknown) => {
      logger.error({ err }, "whatsapp sweep failed; the next tick tries again");
      return null;
    });
    // Staff: shifts left open past the organization's limit ("forgot to clock out?").
    const staffOpenShifts = await flagStaleSessions(deps.mailer, deps.fetchImpl).catch((err: unknown) => {
      logger.error({ err }, "open-shift sweep failed; the next tick tries again");
      return null;
    });
    // Email integrations: due and lost sends, abandoned checkouts, domain checks, token upkeep, retention.
    const email = await sweepEmail(deps).catch((err: unknown) => {
      logger.error({ err }, "email sweep failed; the next tick tries again");
      return null;
    });
    const pixelDedupePruned = await prunePixelDedupe().catch((err: unknown) => {
      logger.error({ err }, "pixel dedupe prune failed; the next tick tries again");
      return null;
    });
    const teamPruned = await pruneTeamDaily(deps).catch((err: unknown) => {
      logger.error({ err }, "team retention sweep failed; the next tick tries again");
      return null;
    });
    const checksPruned = await pruneReconciliations().catch((err: unknown) => {
      logger.error({ err }, "pruning old checks against Shopify failed; the next tick tries again");
      return null;
    });
    const shopifyReportsPruned = await pruneShopifyReports().catch((err: unknown) => {
      logger.error({ err }, "shopify reports prune failed; the next tick tries again");
      return null;
    });
    // Inventory: the scheduled checks against Shopify, the day's stock records, stock alerts.
    const inventory = await sweepInventory(deps).catch((err: unknown) => {
      logger.error({ err }, "inventory sweep failed; the next tick tries again");
      return null;
    });
    const inventoryPruned = await pruneInventory().catch((err: unknown) => {
      logger.error({ err }, "inventory prune failed; the next tick tries again");
      return null;
    });
    return { refreshed, staleJobsFailed, reconciled, salesRereads, adsSynced, whatsapp, staffOpenShifts, email, pixelDedupePruned, teamPruned, checksPruned, shopifyReportsPruned, inventory, inventoryPruned };
  }
  logger.warn({ cron }, "unknown cron trigger");
  return {};
}

/** Email and WhatsApp jobs, and the ad platforms' sync, its schedule and its alerts. */
import { systemDb } from "@app/db";
import {
  logger,
  ADS_RECENT_DAYS,
  classifyAdError,
  enqueueAdHistory,
  enqueueAdSync,
  googleAdsBudget,
  googleAdsBudgetAllows,
  nextHistoryWindow,
  recheckDays,
  sweepNangoOrphans,
  sweepAdAlerts,
  syncAdConnection,
  type AdsSyncData,
  dispatchStore,
  sendWhatsappMessage,
  type WhatsappJob,
  processBusinessEvent,
  retryInvitationEmail,
  sendEmailMessage,
  type EmailJob,
} from "@app/core";
import { UnrecoverableError, type WorkerDeps } from "./common.js";

/** One WhatsApp message, or a store's due messages in a batch (campaigns, catch-up). */
/** Email integrations: send one message, or run the automations for one business event. */
export async function runEmailJob(job: EmailJob, deps: WorkerDeps) {
  if (job.kind === "email_send") return { outcome: await sendEmailMessage(job.messageId, deps) };
  // The delivery record counts attempts and queues the next one itself, so this never throws for a mail failure.
  if (job.kind === "team_invitation") return { outcome: await retryInvitationEmail(job.deliveryId, { mailer: deps.mailer, queues: deps.queues }) };
  return processBusinessEvent(job.eventId, deps);
}

export async function runWhatsappJob(job: WhatsappJob, deps: WorkerDeps) {
  if (job.kind === "whatsapp") return { outcome: await sendWhatsappMessage(job.messageId, deps) };
  return dispatchStore(job.storeId, deps);
}

/**
 * Fetch one ad account's days. Access that has ended or was lost, an account the platform closed,
 * or a request it refuses won't get better by retrying: the connection is marked already (Settings and
 * the alerts word it), and the job stops. Outages throw on, so the queue retries with backoff; a
 * platform that asked to wait (AdsRateLimitedError) is waited for without spending a retry (consume).
 */
export async function runAdsSync(data: AdsSyncData, deps: WorkerDeps) {
  try {
    const res = await syncAdConnection(data.connectionId, data.since, data.until, deps.fetchImpl, {
      // Messages queued before triggers were kept were all asked for by someone or by the schedule; as requests they're never held back.
      trigger: data.trigger ?? "request",
      health: data.health,
      healthOnly: data.healthOnly,
      queues: deps.queues,
      coord: deps.coord,
    });
    if (res.skipped) logger.info({ connectionId: data.connectionId, reason: res.reason, trigger: data.trigger ?? "request" }, "ad account sync skipped");
    else logger.info({ connectionId: data.connectionId, since: res.since, until: res.until, rows: res.stored, trigger: data.trigger ?? "request", continued: res.continued }, "ad account synced");
  } catch (err) {
    if (!classifyAdError(err).retryable) throw new UnrecoverableError("ad sync stopped: the connection is marked", { cause: err });
    throw err;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** One re-check a day per ad account (also its health at the platform). */
const ADS_RECHECK_LEASE_MS = 22 * HOUR;
/** A broken-off walk back through history is picked up again this long after. */
const ADS_HISTORY_RETRY_MS = 6 * HOUR;
/** A new connection's first sync is queued when it is connected: the schedule leaves it to that for this long. */
const ADS_NEW_GRACE_MS = HOUR;
/** Spread a tick's ad syncs over a few minutes, so a busy server doesn't hit Google's and Meta's quotas in one burst. */
const ADS_SPREAD_S = 300;
/**
 * Walks back through history the schedule starts (or picks up again) per tick, across every account.
 * Each walk is a chain of windows a few minutes apart, and Meta's run as long report jobs on the queue
 * Shopify's imports use: after a deploy, when every account is short of history at once, they start
 * a few at a time (about a dozen an hour) instead of all together.
 */
export const ADS_HISTORY_STARTS_PER_TICK = 3;

/**
 * How often an account's last few days are fetched again (null: only the daily re-check). Hourly;
 * Google Ads every 3 hours, since one daily allowance of requests serves every merchant; an account
 * read through Supermetrics every 6 hours, since every query counts against the team's licence (its
 * daily queries and concurrency) and Supermetrics' own data isn't fresher than that for most sources;
 * an account whose syncs keep failing less often (every 6 hours after 3 in a row, only daily after 10).
 */
function recentLeaseMs(c: { provider: string; source: string; consecutiveFailures: number }): number | null {
  if (c.consecutiveFailures >= 10) return null;
  if (c.consecutiveFailures >= 3 || c.source === "supermetrics") return 6 * HOUR - 5 * MINUTE;
  return c.provider === "google" ? 3 * HOUR - 5 * MINUTE : 55 * MINUTE;
}

/** Spends bizinsights' own Google Ads API operations: a real Google Ads account read directly (not the demo, not through Supermetrics). */
const usesGoogleAllowance = (c: { provider: string; isDemo: boolean; source: string }) => c.provider === "google" && !c.isDemo && c.source !== "supermetrics";

/**
 * Keep connected ad accounts current. Runs on the 15-minute tick; leases make most ticks a no-op.
 * Spend for today changes all day; conversions are credited days later, so once a day each account's
 * re-check window is fetched again (recheckDays: Google 90 days, Meta 30, AdSense 30 or the month
 * before) and its health at the platform is read. Accounts with nothing new to read (closed, or a
 * login that lost them) are only asked once a day whether they're back; accounts waiting for a
 * reconnect are left alone. History short of 25 months is walked back a window at a time.
 *
 * Google Ads syncs stop at 80% of the day's allowance (60% for history), so connecting accounts and
 * reports keep the rest, and pause altogether when Google says it is used up.
 */
export async function scheduleAdsSync(deps: WorkerDeps) {
  const now = Date.now();
  const all = await systemDb.adConnection.findMany({
    where: { enabled: true, status: { in: ["active", "error", "permission", "unavailable"] } },
    select: {
      id: true, provider: true, timezone: true, storeId: true, status: true, accountStatus: true, consecutiveFailures: true, isDemo: true, source: true,
      lastSyncedAt: true, createdAt: true, historyFrom: true, syncedThrough: true,
    },
  });
  // A store that uninstalled the app stops pulling ad data with the tokens it left behind; they are
  // revoked when its data is purged (shop/redact), or used again if it reinstalls before that.
  const gone = new Set(
    (await systemDb.store.findMany({ where: { id: { in: [...new Set(all.map((c) => c.storeId))] }, status: "uninstalled" }, select: { id: true } })).map((s) => s.id),
  );
  const conns = all.filter((c) => !gone.has(c.storeId));
  // Google's daily allowance concerns real accounts read directly only: a demo's figures are generated,
  // and Supermetrics reads Google with its own.
  const google = conns.some(usesGoogleAllowance) ? await googleAdsBudget(deps.coord) : null;
  if (google) logger.info({ googleAdsOperations: google.used, allowance: google.limit, paused: google.paused }, "google ads operations in the last 24 hours");
  const spread = () => ({ delaySeconds: Math.floor(Math.random() * ADS_SPREAD_S) });
  let sent = 0;
  let historyStarts = 0;
  for (const c of conns) {
    if (!c.lastSyncedAt && c.createdAt.getTime() > now - ADS_NEW_GRACE_MS) continue;
    if (usesGoogleAllowance(c) && google && !googleAdsBudgetAllows(google, "schedule")) continue;
    const wide = `ads-recheck:${c.id}`;
    // Nothing new to read: once a day, ask the platform whether the account is back.
    if (c.status === "permission" || c.status === "unavailable" || c.accountStatus === "closed") {
      if (await deps.coord.acquire(wide, ADS_RECHECK_LEASE_MS)) {
        await sendOrRelease(deps, wide, () => enqueueAdSync(deps.queues, c, 1, { trigger: "schedule", healthOnly: true, ...spread() }));
        sent++;
      }
      continue;
    }
    const recent = `ads-recent:${c.id}`;
    const recentMs = recentLeaseMs(c);
    const lease = (await deps.coord.acquire(wide, ADS_RECHECK_LEASE_MS)) ? wide : recentMs && (await deps.coord.acquire(recent, recentMs)) ? recent : null;
    if (lease) {
      await sendOrRelease(deps, lease, () =>
        enqueueAdSync(deps.queues, c, lease === wide ? recheckDays(c) : ADS_RECENT_DAYS, { trigger: "schedule", ...(lease === wide ? { health: true } : {}), ...spread() }),
      );
      sent++;
    }
    // A walk back through history that broke off (a window failed, or waited for Google's allowance),
    // or one never started (accounts connected before history was walked). A few per tick; the lease
    // keeps a walk that is on its way from being started twice, the others wait for a later tick.
    if (historyStarts < ADS_HISTORY_STARTS_PER_TICK && c.status === "active" && nextHistoryWindow(c) && (!usesGoogleAllowance(c) || (google && googleAdsBudgetAllows(google, "history")))) {
      if (await enqueueAdHistory(deps.queues, deps.coord, c, { leaseMs: ADS_HISTORY_RETRY_MS, ...spread() })) {
        sent++;
        historyStarts++;
      }
    }
  }
  return sent;
}

/** Queue it, or give the lease back so the next tick tries again. */
async function sendOrRelease(deps: WorkerDeps, lease: string, send: () => Promise<void>) {
  try {
    await send();
  } catch (err) {
    await deps.coord.release(lease).catch(() => {});
    throw err;
  }
}

/** Ad connections' alerts (core's sweepAdAlerts): raised from what the connections say, closed once nothing calls for them. */
export async function sweepAdConnectionAlerts(deps: Pick<WorkerDeps, "mailer" | "fetchImpl">) {
  return sweepAdAlerts({ mailer: deps.mailer, fetchImpl: deps.fetchImpl });
}

/** Nango connections a merchant authorized but never finished connecting (docs/nango.md): let go after a grace period. */
export async function sweepNangoLeftovers(deps: Pick<WorkerDeps, "coord" | "fetchImpl">) {
  return sweepNangoOrphans(deps.coord, deps.fetchImpl);
}

/** Email and WhatsApp jobs, and the ad platforms' sync and its schedule. */
import { systemDb } from "@app/db";
import { logger, ADS_RECENT_DAYS, AdsApiError, AdsAuthError, enqueueAdSync, recheckDays, syncAdConnection, type AdsSyncData, dispatchStore, sendWhatsappMessage, type WhatsappJob, processBusinessEvent, retryInvitationEmail, sendEmailMessage, type EmailJob } from "@app/core";
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
 * Fetch one ad account's days. Access that has ended, or a request the platform refuses, won't
 * get better by retrying: the connection is marked (reconnect / error) for Settings to show, and
 * the job stops. Rate limits and outages throw on, so the queue retries with backoff.
 */
export async function runAdsSync(data: AdsSyncData, deps: WorkerDeps) {
  try {
    const res = await syncAdConnection(data.connectionId, data.since, data.until, deps.fetchImpl);
    if (!res.skipped) logger.info({ connectionId: data.connectionId, since: data.since, until: data.until, rows: res.stored }, "ad account synced");
  } catch (err) {
    if (err instanceof AdsAuthError || err instanceof AdsApiError) throw new UnrecoverableError(err.message);
    throw err;
  }
}

/** One recent-days refresh per ad account per hour, and one 30-day re-check a day. */
const ADS_RECENT_LEASE_MS = 55 * 60_000;
const ADS_RECHECK_LEASE_MS = 22 * 3600_000;
/** Spread a tick's ad syncs over a few minutes, so a busy server doesn't hit Google's and Meta's quotas in one burst. */
const ADS_SPREAD_S = 300;

/**
 * Keep connected ad accounts current. Runs on the 15-minute tick; leases make most ticks a no-op.
 * Spend for today changes all day; conversions are attributed days later, so once a day the last
 * 30 days are fetched again (the whole 90 while an account's history falls short, see
 * `recheckDays`). Accounts waiting for a reconnect are left alone.
 */
export async function scheduleAdsSync(deps: WorkerDeps) {
  const all = await systemDb.adConnection.findMany({
    where: { enabled: true, status: { in: ["active", "error"] } },
    select: { id: true, timezone: true, storeId: true, lastSyncedAt: true, historyFrom: true },
  });
  // A store that uninstalled the app stops pulling ad data with the tokens it left behind; they are
  // revoked when its data is purged (shop/redact), or used again if it reinstalls before that.
  const gone = new Set(
    (await systemDb.store.findMany({ where: { id: { in: [...new Set(all.map((c) => c.storeId))] }, status: "uninstalled" }, select: { id: true } })).map((s) => s.id),
  );
  const conns = all.filter((c) => !gone.has(c.storeId));
  let sent = 0;
  for (const c of conns) {
    const wide = `ads-recheck:${c.id}`;
    const recent = `ads-recent:${c.id}`;
    const lease = (await deps.coord.acquire(wide, ADS_RECHECK_LEASE_MS)) ? wide : (await deps.coord.acquire(recent, ADS_RECENT_LEASE_MS)) ? recent : null;
    if (!lease) continue;
    try {
      await enqueueAdSync(deps.queues, c, lease === wide ? recheckDays(c) : ADS_RECENT_DAYS, { delaySeconds: Math.floor(Math.random() * ADS_SPREAD_S) });
      sent++;
    } catch (err) {
      await deps.coord.release(lease).catch(() => {});
      throw err;
    }
  }
  return sent;
}

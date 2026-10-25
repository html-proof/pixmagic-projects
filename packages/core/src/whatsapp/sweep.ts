/**
 * The 15-minute sweep: whatever the queue didn't (or couldn't) carry.
 *
 *  - Messages due soon that aren't on the queue (due later than SQS can delay, or a lost message).
 *  - Sends cut off mid-call (the jobs function stopped): failed as "uncertain", never re-sent on their own.
 *  - Webhook deliveries still waiting: queued again; after WA_WEBHOOK_MAX_ATTEMPTS, set aside and alerted.
 *  - Campaigns: started at their time, a stalled batch chain picked up, finished ones completed.
 *  - Connections: a health check every 6 hours each (20 a tick); messages held for a connection that
 *    has needed the merchant for 48 hours are cancelled.
 *  - bizinsights' app webhook pointed at bizinsights (every 6 hours), stray tokens at Nango (hourly),
 *    retention (daily).
 *
 * Each part runs on its own: one that throws is logged and the rest still run.
 */
import { systemDb } from "@app/db";
import { providerDetail } from "../errors.js";
import { logger } from "../logger.js";
import { recordAppWebhook } from "./automation.js";
import { waPlatform, waQueue, waWebhookUrl, type WaDeps } from "./common.js";
import { checkConnection } from "./connect.js";
import { completeCampaigns, resumeStalledDispatch, startDueCampaigns } from "./campaigns.js";
import { ensureAppWebhook, WhatsappApiError } from "./graph.js";
import { enqueueSend, HOLD_LIMIT_MS } from "./messages.js";
import { sweepStrayNangoTokens } from "./nango.js";
import { setWebhookAside, WA_WEBHOOK_MAX_ATTEMPTS } from "./webhook.js";

/** How long each kind of record is kept. */
export const RETENTION = {
  /** Messages (and their delivery reports), from when they ended. */
  messageDays: 365,
  /** What a failed message needs to be retried. */
  failedPayloadDays: 7,
  /** Webhook deliveries once applied, and set-aside ones. */
  webhookDays: 7,
  deadWebhookDays: 30,
  /** Workflow runs. */
  runDays: 90,
};

const DAY = 86_400_000;

async function part<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, part: name }, "whatsapp sweep part failed; the next tick tries again");
    return null;
  }
}

export async function sweepWhatsapp(deps: WaDeps, now = new Date()) {
  const due = await part("due", async () => {
    const rows = await systemDb.waMessage.findMany({
      where: { status: "queued", sendAfter: { lte: new Date(now.getTime() + 15 * 60_000) }, OR: [{ enqueuedAt: null }, { enqueuedAt: { lt: new Date(now.getTime() - 30 * 60_000) } }] },
      select: { id: true, sendAfter: true, status: true },
      orderBy: { sendAfter: "asc" },
      take: 1000,
    });
    for (const m of rows) await enqueueSend(m, deps);
    return rows.length;
  });

  const cutOff = await part("sending", async () => {
    const r = await systemDb.waMessage.updateMany({
      where: { status: "sending", updatedAt: { lt: new Date(now.getTime() - 10 * 60_000) } },
      data: { status: "failed", reason: "uncertain", failedAt: now, finalAt: now, errorTitle: "Sending was cut off, so it may or may not have reached WhatsApp. Check with the customer before sending it again." },
    });
    return r.count;
  });

  const webhooks = await part("webhooks", async () => {
    const waiting = await systemDb.waWebhookEvent.findMany({
      where: { status: "pending", receivedAt: { lt: new Date(now.getTime() - 5 * 60_000) }, OR: [{ enqueuedAt: null }, { enqueuedAt: { lt: new Date(now.getTime() - 10 * 60_000) } }] },
      select: { id: true, attempts: true },
      take: 200,
    });
    let requeued = 0;
    let setAside = 0;
    for (const ev of waiting) {
      if (ev.attempts >= WA_WEBHOOK_MAX_ATTEMPTS) {
        await setWebhookAside(ev.id, deps);
        setAside++;
      } else {
        await waQueue(deps.queues).send({ kind: "whatsapp_webhook", eventId: ev.id });
        await systemDb.waWebhookEvent.update({ where: { id: ev.id }, data: { enqueuedAt: now } });
        requeued++;
      }
    }
    return { requeued, setAside };
  });

  const campaigns = await part("campaigns", async () => ({
    started: await startDueCampaigns(deps),
    resumed: await resumeStalledDispatch(deps),
    completed: await completeCampaigns(),
  }));

  const health = await part("health", async () => {
    const conns = await systemDb.waConnection.findMany({
      where: { status: { notIn: ["disconnected"] }, nangoConnectionId: { not: null }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now.getTime() - 6 * 3600_000) } }] },
      orderBy: { lastCheckedAt: { sort: "asc", nulls: "first" } },
      take: 20,
    });
    let checked = 0;
    for (const c of conns) {
      if (!(await deps.coord.acquire(`wa:check:${c.id}`, 6 * 3600_000))) continue;
      await checkConnection(deps, c).catch((err: unknown) => logger.warn({ err, storeId: c.storeId }, "whatsapp health check failed"));
      checked++;
    }
    return checked;
  });

  const held = await part("held", async () => {
    const stuck = await systemDb.waConnection.findMany({ where: { status: { in: ["reconnect", "error", "action_required"] }, reconnectSince: { lt: new Date(now.getTime() - HOLD_LIMIT_MS) } }, select: { storeId: true } });
    if (!stuck.length) return 0;
    const r = await systemDb.waMessage.updateMany({
      where: { storeId: { in: stuck.map((s) => s.storeId) }, status: "queued" },
      data: { status: "cancelled", reason: "reconnect_timeout", finalAt: now, payloadEnc: null },
    });
    return r.count;
  });

  const appWebhook = await part("app_webhook", async () => {
    const p = waPlatform();
    if (!p || !(await deps.coord.acquire("wa:app-webhook", 6 * 3600_000))) return null;
    let outcome: Awaited<ReturnType<typeof ensureAppWebhook>>;
    try {
      outcome = await ensureAppWebhook(p, waWebhookUrl(), deps.fetchImpl);
    } catch (err) {
      // Kept for the dashboard's platform check, then thrown so the sweep logs it.
      await recordAppWebhook(deps.coord, { outcome: "failed", detail: err instanceof WhatsappApiError ? `${err.httpStatus}${err.code !== null ? ` #${err.code}` : ""}: ${providerDetail(err.details ?? err.title)}`.slice(0, 200) : "no answer" });
      throw err;
    }
    await recordAppWebhook(deps.coord, { outcome });
    if (outcome === "in_use") logger.warn({ appId: p.appId }, "whatsapp: the app's webhook points elsewhere; set it to bizinsights' URL in Meta's dashboard (docs/whatsapp.md)");
    return outcome;
  });

  const strayTokens = await part("stray_tokens", async () => {
    if (!(await deps.coord.acquire("wa:stray-tokens", 3600_000))) return null;
    return sweepStrayNangoTokens(deps.fetchImpl);
  });

  const retention = await part("retention", async () => {
    if (!(await deps.coord.acquire("wa:retention", 20 * 3600_000))) return null;
    const oldMessages = await systemDb.waMessage.findMany({ where: { finalAt: { lt: new Date(now.getTime() - RETENTION.messageDays * DAY) } }, select: { id: true }, take: 5000 });
    const ids = oldMessages.map((m) => m.id);
    const [events, messages, payloads, hooks, dead, runs] = await systemDb.$transaction([
      systemDb.waMessageEvent.deleteMany({ where: { messageId: { in: ids } } }),
      systemDb.waMessage.deleteMany({ where: { id: { in: ids } } }),
      systemDb.waMessage.updateMany({ where: { status: "failed", payloadEnc: { not: null }, finalAt: { lt: new Date(now.getTime() - RETENTION.failedPayloadDays * DAY) } }, data: { payloadEnc: null } }),
      systemDb.waWebhookEvent.deleteMany({ where: { status: "processed", processedAt: { lt: new Date(now.getTime() - RETENTION.webhookDays * DAY) } } }),
      systemDb.waWebhookEvent.deleteMany({ where: { status: "dead", processedAt: { lt: new Date(now.getTime() - RETENTION.deadWebhookDays * DAY) } } }),
      systemDb.waWorkflowRun.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - RETENTION.runDays * DAY) } } }),
    ]);
    return { events: events.count, messages: messages.count, payloads: payloads.count, webhooks: hooks.count + dead.count, runs: runs.count };
  });

  return { due, cutOff, webhooks, campaigns, health, held, appWebhook, strayTokens, retention };
}

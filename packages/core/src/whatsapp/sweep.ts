/**
 * The WhatsApp sweep, every 15 minutes on its own lease (apps/worker runScheduled):
 *  - messages due within the next tick go to the queue (SQS can't delay past 15 minutes), and a
 *    send that never finished (the worker died mid-call) is marked uncertain rather than repeated;
 *  - campaigns start when due, and finish once every message is final;
 *  - what is left of QR linking is retired (retireQr.ts), until nothing is;
 *  - each connection is checked with Meta every few hours (its access may have been removed in
 *    Meta's business settings without a word to bizinsights), and one down past the grace period has
 *    its waiting messages cancelled;
 *  - QR-linked phones' stored webhook events that weren't applied are retried, then set aside;
 *  - retention: message texts after the store's retention, the records themselves after a year,
 *    automation runs after 90 days;
 *  - Meta's tokens renewed before they expire, and Meta's review of submitted templates.
 */
import { systemDb } from "@app/db";
import { WA_DEFAULT_RETENTION_DAYS } from "@app/shared";
import { logger } from "../logger.js";
import { raiseAlert } from "../notify.js";
import { DOWN_GRACE_MS, WA_ALERTS, waQueue, type WaDeps } from "./common.js";
import { checkConnection } from "./connection.js";
import { enqueueIfDue } from "./messages.js";
import { retireQrLinking } from "./retireQr.js";
import { refreshMetaTemplates } from "./templates.js";
import { WEBHOOK_MAX_ATTEMPTS } from "./webhook.js";
import { renewCloudToken } from "./cloud.js";

const LEASE_MS = 14 * 60_000;
/** What the privacy policy promises (apps/web/src/app/privacy/page.tsx): message records a year, automation runs 90 days. */
const KEEP_RECORDS_MS = 365 * 86_400_000;
const KEEP_RUNS_MS = 90 * 86_400_000;
/** How often a connection is asked about with Meta when nothing else told bizinsights about it. */
const CHECK_EVERY_MS = 6 * 3600_000;

export async function sweepWhatsapp(deps: Pick<WaDeps, "queues" | "fetchImpl" | "mailer" | "coord">): Promise<Record<string, number | boolean> | null> {
  if (!(await deps.coord.acquire("sweep:whatsapp", LEASE_MS))) return null;
  const out: Record<string, number | boolean> = {};
  const step = async (name: string, fn: () => Promise<number | boolean>) => {
    try {
      out[name] = await fn();
    } catch (err) {
      logger.error({ err, step: name }, "whatsapp sweep step failed; the next tick tries again");
    }
  };
  const now = Date.now();

  await step("due", async () => {
    const due = await systemDb.wappMessage.findMany({
      where: { status: "queued", sendAfter: { lte: new Date(now + LEASE_MS) }, OR: [{ enqueuedAt: null }, { enqueuedAt: { lt: new Date(now - 20 * 60_000) } }] },
      select: { id: true, sendAfter: true, status: true },
      orderBy: { sendAfter: "asc" },
      take: 2000,
    });
    let n = 0;
    for (const m of due) if (await enqueueIfDue(deps, m)) n++;
    return n;
  });

  await step("stuckSends", async () => {
    const { count } = await systemDb.wappMessage.updateMany({
      where: { status: "sending", updatedAt: { lt: new Date(now - 15 * 60_000) } },
      data: { status: "failed", reason: "gave_up", errorCode: "uncertain", errorDetail: "The send didn't finish. It may have reached the customer: check the chat before sending it again.", failedAt: new Date(), finalAt: new Date(), payloadEnc: null },
    });
    if (count) logger.warn({ count }, "whatsapp sends that never finished marked uncertain");
    return count;
  });

  await step("campaignsStarted", async () => {
    const due = await systemDb.wappCampaign.findMany({ where: { OR: [{ status: "scheduled", scheduledAt: { lte: new Date(now + LEASE_MS) } }, { status: "sending", materializedAt: null, updatedAt: { lt: new Date(now - 10 * 60_000) } }] }, select: { id: true, scheduledAt: true } });
    for (const c of due) await waQueue(deps.queues).send({ kind: "wapp_campaign", campaignId: c.id }, { delaySeconds: Math.max(0, Math.min(900, Math.ceil(((c.scheduledAt?.getTime() ?? now) - now) / 1000))) });
    return due.length;
  });

  await step("campaignsCompleted", async () => {
    const sending = await systemDb.wappCampaign.findMany({ where: { status: "sending", materializedAt: { not: null } }, select: { id: true } });
    let n = 0;
    for (const c of sending) {
      const open = await systemDb.wappMessage.count({ where: { campaignId: c.id, status: { in: ["queued", "sending"] } } });
      if (!open) {
        await systemDb.wappCampaign.update({ where: { id: c.id }, data: { status: "completed", completedAt: new Date() } });
        n++;
      }
    }
    return n;
  });

  await step("qrRetired", async () => {
    const r = await retireQrLinking(deps);
    if (r) out.qrInstancesLeft = r.left;
    return r?.retired ?? 0;
  });

  await step("connections", async () => {
    const due = await systemDb.wappConnection.findMany({
      where: { provider: "cloud_api", status: "connected", instanceTokenEnc: { not: null }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now - CHECK_EVERY_MS) } }] },
      orderBy: { lastCheckedAt: "asc" },
      take: 200,
    });
    let changed = 0;
    for (const c of due) {
      try {
        if ((await checkConnection(deps, c)).status !== c.status) changed++;
      } catch (err) {
        // Meta not answering now isn't a disconnection: the next sweep asks again.
        logger.warn({ err, connectionId: c.id }, "whatsapp connection not checked with Meta; the next sweep tries again");
      }
    }
    return changed;
  });

  await step("downTooLong", async () => {
    const down = await systemDb.wappConnection.findMany({ where: { downSince: { lt: new Date(now - DOWN_GRACE_MS) }, status: { in: ["reconnecting", "logged_out", "failed"] } }, select: { storeId: true, workspaceId: true } });
    let n = 0;
    for (const c of down) {
      n += (await systemDb.wappMessage.updateMany({ where: { storeId: c.storeId, direction: "out", status: "queued" }, data: { status: "cancelled", reason: "not_connected", finalAt: new Date(), payloadEnc: null } })).count;
      await systemDb.wappCampaign.updateMany({ where: { storeId: c.storeId, status: { in: ["scheduled", "sending"] } }, data: { status: "cancelled", cancelledAt: new Date(), cancelReason: "not_connected" } });
      await raiseAlert({ workspaceId: c.workspaceId, storeId: c.storeId, severity: "warning", code: WA_ALERTS.down, message: "WhatsApp has been disconnected for 2 days; waiting messages were cancelled." }, deps.mailer, deps.fetchImpl);
    }
    return n;
  });

  await step("webhookRetries", async () => {
    const stale = await systemDb.wappWebhookEvent.findMany({ where: { status: "pending", receivedAt: { lt: new Date(now - 10 * 60_000) } }, select: { id: true, attempts: true }, take: 500 });
    let n = 0;
    for (const e of stale) {
      if (e.attempts >= WEBHOOK_MAX_ATTEMPTS) {
        await systemDb.wappWebhookEvent.update({ where: { id: e.id }, data: { status: "dead", bodyEnc: null, processedAt: new Date(), lastError: "gave up after retries" } });
        continue;
      }
      await waQueue(deps.queues).send({ kind: "wapp_event", eventId: e.id });
      n++;
    }
    return n;
  });

  await step("retention", async () => {
    let cleared = 0;
    const custom = await systemDb.wappSettings.findMany({ where: { retentionDays: { not: WA_DEFAULT_RETENTION_DAYS } }, select: { storeId: true, retentionDays: true } });
    for (const s of custom) {
      cleared += (await systemDb.wappMessage.updateMany({ where: { storeId: s.storeId, previewEnc: { not: null }, createdAt: { lt: new Date(now - s.retentionDays * 86_400_000) } }, data: { previewEnc: null } })).count;
    }
    cleared += (
      await systemDb.wappMessage.updateMany({
        where: { storeId: { notIn: custom.map((s) => s.storeId) }, previewEnc: { not: null }, createdAt: { lt: new Date(now - WA_DEFAULT_RETENTION_DAYS * 86_400_000) } },
        data: { previewEnc: null },
      })
    ).count;
    // A final message needs nothing to send any more.
    await systemDb.wappMessage.updateMany({ where: { payloadEnc: { not: null }, finalAt: { lt: new Date(now - 86_400_000) } }, data: { payloadEnc: null } });
    const old = new Date(now - KEEP_RECORDS_MS);
    const oldIds = (await systemDb.wappMessage.findMany({ where: { createdAt: { lt: old } }, select: { id: true }, take: 5000 })).map((m) => m.id);
    if (oldIds.length) {
      await systemDb.$transaction([systemDb.wappMessageEvent.deleteMany({ where: { messageId: { in: oldIds } } }), systemDb.wappMessage.deleteMany({ where: { id: { in: oldIds } } })]);
    }
    await systemDb.wappAutomationRun.deleteMany({ where: { createdAt: { lt: new Date(now - KEEP_RUNS_MS) } } });
    await systemDb.wappWebhookEvent.deleteMany({ where: { OR: [{ status: { in: ["processed", "ignored"] }, receivedAt: { lt: new Date(now - 7 * 86_400_000) } }, { status: "dead", receivedAt: { lt: new Date(now - 30 * 86_400_000) } }] } });
    await systemDb.wappSettings.updateMany({ where: { testCodeExpiresAt: { lt: new Date(now) } }, data: { testCodeHash: null, testCodeExpiresAt: null } });
    return cleared + oldIds.length;
  });

  await step("cloudTokens", async () => {
    const soon = await systemDb.wappConnection.findMany({ where: { provider: "cloud_api", status: "connected", instanceTokenEnc: { not: null }, tokenExpiresAt: { lt: new Date(now + 30 * 86_400_000) } } });
    let n = 0;
    for (const c of soon) if (await renewCloudToken(deps, c).catch((err: unknown) => (logger.warn({ err, connectionId: c.id }, "whatsapp cloud api token not renewed; the next sweep tries again"), false))) n++;
    return n;
  });

  await step("metaTemplates", async () => {
    const conns = await systemDb.wappConnection.findMany({ where: { provider: "cloud_api", status: "connected", instanceTokenEnc: { not: null } } });
    let n = 0;
    for (const c of conns) {
      const pending = await systemDb.wappTemplate.count({ where: { storeId: c.storeId, metaName: { not: null }, metaStatus: { in: ["PENDING", "IN_APPEAL"] } } });
      if (pending) n += await refreshMetaTemplates(deps, c).catch(() => 0);
    }
    return n;
  });

  return out;
}

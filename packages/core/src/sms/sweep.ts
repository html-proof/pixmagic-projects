/**
 * The 15-minute sweep (apps/worker runScheduled): everything Customer Messaging does on a clock.
 *  - texts due in the next 15 minutes onto the queue (and any a lost queue message left behind);
 *  - sends cut off mid-call → "uncertain" (never re-sent); texts AWS accepted but never reported
 *    on for 74 hours → "unknown" (AWS itself gives up at 72);
 *  - campaigns started when due, completed when nothing is left;
 *  - once a day: inactive and VIP customer rules, senders re-checked with AWS, retention;
 *  - AWS's opt-out lists (STOP replies, numbers opted out in the console) onto the stores'
 *    suppression lists.
 * Each step runs on its own: one that throws is logged and the rest still run.
 */
import { systemDb } from "@app/db";
import { billingMonth, FINAL_EVENT_WAIT_MS } from "@app/shared/sms";
import { logger } from "../logger.js";
import { parseRule, runSmsRules } from "./automations.js";
import { completeCampaigns, startDueCampaigns } from "./campaigns.js";
import { smsRegion, type SmsDeps } from "./common.js";
import { suppressNumber } from "./contacts.js";
import { checkBudget } from "./delivery.js";
import { enqueueSmsSend, settleStuckSends } from "./messages.js";
import { verifySender } from "./senders.js";
import { ensureSmsWebhooks } from "./events.js";
import { storeGraphql } from "../inventory/shopify.js";

/** How long Customer Messaging keeps what it holds (applied daily). */
export const SMS_RETENTION = {
  /** A text's words, after its outcome is known. */
  bodyDays: 30,
  /** AWS's delivery events. */
  eventDays: 180,
  /** Checkouts (their recovery link goes with them). */
  checkoutDays: 90,
  /** Message history and cost records: 13 months, for a year's comparison. */
  jobDays: 400,
};

const tick = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, step: what }, "sms sweep step failed");
    return null;
  }
};

export async function sweepSms(deps: SmsDeps, now = new Date()) {
  const any = await systemDb.smsSenderConfiguration.count();
  if (!any) return { senders: 0 };
  const stuck = await tick("stuck", () => settleStuckSends());
  const queued = await tick("enqueue", () => enqueueDue(deps, now));
  const unknown = await tick("unknown", () => markUnknown(now));
  const started = await tick("campaigns", () => startDueCampaigns(deps, now));
  const completed = await tick("complete", () => completeCampaigns());
  const optOuts = await tick("opt-outs", () => syncOptOuts(deps));
  let daily: Awaited<ReturnType<typeof dailySms>> | null = null;
  if (await deps.coord.acquire(`sms:daily:${now.toISOString().slice(0, 10)}`, 26 * 3600_000)) daily = await tick("daily", () => dailySms(deps, now));
  return { senders: any, stuck, queued, unknown, started, completed, optOuts, daily };
}

/** Scheduled texts due within the next 15 minutes that aren't on the queue (or whose queue message is overdue). */
async function enqueueDue(deps: SmsDeps, now: Date): Promise<number> {
  const horizon = new Date(now.getTime() + 15 * 60_000);
  const stale = new Date(now.getTime() - 30 * 60_000);
  const due = await systemDb.smsMessageJob.findMany({
    where: { status: "scheduled", sendAfter: { lte: horizon }, OR: [{ enqueuedAt: null }, { enqueuedAt: { lt: stale } }] },
    orderBy: { sendAfter: "asc" },
    take: 900,
    select: { id: true, sendAfter: true, status: true },
  });
  let n = 0;
  for (const j of due) if (await enqueueSmsSend(j, deps)) n++;
  return n;
}

/** AWS accepted these and never said what happened: "unknown", for good (a late final event still settles them). */
async function markUnknown(now: Date): Promise<number> {
  const { count } = await systemDb.smsMessageJob.updateMany({
    where: { status: { in: ["accepted", "pending"] }, acceptedAt: { lt: new Date(now.getTime() - FINAL_EVENT_WAIT_MS) } },
    data: { status: "unknown", reason: "no_final_event", finalAt: now, valuesEnc: null },
  });
  return count;
}

/** AWS's opt-out lists onto the suppression list of every store texting through them. */
async function syncOptOuts(deps: SmsDeps): Promise<number> {
  const senders = await systemDb.smsSenderConfiguration.findMany({ where: { identityCheck: "verified" }, select: { storeId: true, workspaceId: true, awsRegion: true, optOutList: true } });
  const lists = new Map<string, Array<{ storeId: string; workspaceId: string }>>();
  for (const s of senders) {
    const key = `${smsRegion(s)}|${s.optOutList || "Default"}`;
    lists.set(key, [...(lists.get(key) ?? []), { storeId: s.storeId, workspaceId: s.workspaceId }]);
  }
  let added = 0;
  for (const [key, stores] of lists) {
    const [region, list] = key.split("|") as [string, string];
    const lease = `sms:optout-sync:${key}`;
    if (!(await deps.coord.acquire(lease, 14 * 60_000))) continue;
    const cursorKey = `sms:optout-cursor:${key}`;
    const since = await deps.coord.peek(cursorKey);
    const numbers = await deps.sms.optedOut(region, list, since ? new Date(since) : null);
    let newest = since ? new Date(since) : null;
    for (const n of numbers) {
      for (const s of stores) {
        const r = await suppressNumber({ id: s.storeId, workspaceId: s.workspaceId }, n.e164, "all", "aws_opt_out", { evidence: { optOutList: list, optedOutAt: n.at.toISOString() } });
        if (r.created) added++;
      }
      if (!newest || n.at > newest) newest = n.at;
    }
    if (newest) await deps.coord.put(cursorKey, newest.toISOString(), 400 * 86400);
  }
  return added;
}

async function dailySms(deps: SmsDeps, now: Date) {
  const customers = await tick("customer-rules", () => customerRules(deps, now));
  const verified = await tick("verify-senders", async () => {
    const due = await systemDb.smsSenderConfiguration.findMany({ where: { OR: [{ identityCheckedAt: null }, { identityCheckedAt: { lt: new Date(now.getTime() - 20 * 3600_000) } }] }, take: 20 });
    for (const s of due) await verifySender({ id: s.storeId, workspaceId: s.workspaceId }, deps, null);
    return due.length;
  });
  const budgets = await tick("budgets", async () => {
    const all = await systemDb.smsSenderConfiguration.findMany({ select: { storeId: true } });
    for (const s of all) await checkBudget(s.storeId, deps);
    return all.length;
  });
  const retention = await tick("retention", () => applyRetention(now));
  const webhooks = await tick("consent-webhooks", async () => {
    const senders = await systemDb.smsSenderConfiguration.findMany({ select: { storeId: true } });
    const stores = await systemDb.store.findMany({ where: { id: { in: senders.map((s) => s.storeId) }, status: "active", grantedScopes: { has: "read_customers" } } });
    let n = 0;
    for (const store of stores) n += await ensureSmsWebhooks(store, storeGraphql(store, deps.coord, deps.fetchImpl), deps.coord).catch((err: unknown) => (logger.warn({ err, storeId: store.id }, "sms consent webhook check failed"), 0));
    return n;
  });
  return { customers, verified, budgets, retention, webhooks, month: billingMonth(now) };
}

/** Inactive and VIP customers: each rule reaches each customer once per inactive stretch (inactive) or once (VIP). */
async function customerRules(deps: SmsDeps, now: Date): Promise<number> {
  const rules = await systemDb.smsAutomationRule.findMany({ where: { status: "active", activeTrigger: { in: ["customer_inactive", "customer_vip"] } } });
  let n = 0;
  for (const rule of rules) {
    const cfg = parseRule(rule.activeConfig);
    if (!cfg) continue;
    const store = await systemDb.store.findUnique({ where: { id: rule.storeId } });
    if (!store || store.status === "uninstalled") continue;
    const base = { storeId: store.id, consentState: "subscribed", suppressedAll: false, suppressedMarketing: false };
    const contacts =
      cfg.trigger === "customer_inactive"
        ? await systemDb.smsContact.findMany({ where: { ...base, ordersCount: { gte: 1 }, lastOrderAt: { lt: new Date(now.getTime() - (cfg.inactiveDays ?? 90) * 86400_000) } }, take: 500 })
        : await systemDb.smsContact.findMany({ where: { ...base, OR: [...(cfg.vipMinOrders ? [{ ordersCount: { gte: cfg.vipMinOrders } }] : []), ...(cfg.vipMinSpent ? [{ totalSpent: { gte: cfg.vipMinSpent } }] : [])] }, take: 500 });
    for (const c of contacts) {
      // Inactive: once per stretch without orders (keyed by the last order's day). VIP: once.
      const key = cfg.trigger === "customer_inactive" ? `inactive:${c.id}:${c.lastOrderAt?.toISOString().slice(0, 10) ?? "never"}` : `vip:${c.id}`;
      const runs = await runSmsRules(
        cfg.trigger,
        {
          key,
          store,
          contact: c,
          facts: { country: c.country, customerOrders: c.ordersCount, customerSpent: Number(c.totalSpent), daysSinceLastOrder: c.lastOrderAt ? Math.floor((now.getTime() - c.lastOrderAt.getTime()) / 86400_000) : null },
          values: {},
          at: now,
        },
        deps,
      );
      n += runs.filter((r) => r.outcome === "scheduled" || r.outcome === "dry_run").length;
    }
  }
  return n;
}

async function applyRetention(now: Date) {
  const days = (d: number) => new Date(now.getTime() - d * 86400_000);
  const [bodies, events, checkouts, expired, jobs] = await Promise.all([
    systemDb.smsMessageJob.updateMany({ where: { finalAt: { lt: days(SMS_RETENTION.bodyDays) }, bodyEnc: { not: null } }, data: { bodyEnc: null, valuesEnc: null } }),
    systemDb.smsDeliveryEvent.deleteMany({ where: { receivedAt: { lt: days(SMS_RETENTION.eventDays) } } }),
    systemDb.smsCheckout.deleteMany({ where: { updatedAt: { lt: days(SMS_RETENTION.checkoutDays) } } }),
    systemDb.smsCheckout.updateMany({ where: { status: "open", lastActivityAt: { lt: days(30) } }, data: { status: "expired", recoveryUrlEnc: null } }),
    systemDb.smsMessageJob.deleteMany({ where: { createdAt: { lt: days(SMS_RETENTION.jobDays) }, status: { notIn: ["scheduled", "sending"] } } }),
  ]);
  return { bodies: bodies.count, events: events.count, checkouts: checkouts.count, expired: expired.count, jobs: jobs.count };
}

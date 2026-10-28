/**
 * The outbox: an event is written where it happens (an alert raised, a WhatsApp message failing, an
 * ad sync's figures crossing a trigger's amount), with one delivery row per Zap trigger that may
 * receive it, and handed to the worker (zapier/delivery.ts). A store with no trigger for the event
 * writes nothing: one indexed lookup is all an event costs it.
 *
 * Writing an event never throws: it is called from the middle of other work (raiseAlert, a WhatsApp
 * status report), which must not fail because Zapier's side of it did.
 */
import { Prisma, systemDb, type WappMessage } from "@app/db";
import { ALERT_PATH, describeAlert } from "@app/shared/alerts";
import { WA_SKIP_LABEL, type WaSkipReason } from "@app/shared/whatsapp";
import type { ZapierEvent } from "@app/shared/zapier";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { Queues } from "../queues.js";
import { authorizerAccess, eventDataAllowed, type AuthorizerAccess } from "./access.js";
import { zapierQueue, type ZapierEnvelope } from "./common.js";

export interface ZapierEventInput {
  workspaceId: string;
  storeId: string;
  event: ZapierEvent;
  /** One per happening: the same key twice writes one event (a retried job, an alert raised again). */
  dedupeKey: string;
  data: Record<string, unknown>;
  occurredAt?: Date;
  /** For one trigger only (a threshold crossed for its amount); otherwise every trigger of the event. */
  hookId?: string;
}

/** The members behind several grants, each looked up once. */
async function authorizers(grants: Array<{ id: string; workspaceId: string; userId: string; storeId: string }>, now: Date): Promise<Map<string, AuthorizerAccess | null>> {
  const out = new Map<string, AuthorizerAccess | null>();
  for (const g of grants) if (!out.has(g.id)) out.set(g.id, await authorizerAccess(g, now));
  return out;
}

/**
 * Write one event and its deliveries, and queue them when `queues` is given (otherwise the cron
 * sweep sends them, within 15 minutes). Returns how many deliveries were made.
 */
export async function recordZapierEvent(input: ZapierEventInput, queues?: Pick<Queues, "sync">, now = new Date()): Promise<number> {
  try {
    const hooks = await systemDb.zapierHook.findMany({
      where: { storeId: input.storeId, event: input.event, ...(input.hookId ? { id: input.hookId } : {}), grant: { revokedAt: null } },
      include: { grant: true },
    });
    if (!hooks.length) return 0;
    const who = await authorizers(
      hooks.map((h) => h.grant),
      now,
    );
    const allowed = hooks.filter((h) => {
      const w = who.get(h.grantId);
      return !!w && eventDataAllowed(input.event, input.data, w);
    });
    if (!allowed.length) return 0;
    const store = [...who.values()].find((w) => w)!.store;
    const envelope: ZapierEnvelope = {
      id: input.dedupeKey,
      event: input.event,
      occurred_at: (input.occurredAt ?? now).toISOString(),
      store: { id: store.id, name: store.name ?? store.shopDomain, shop_domain: store.shopDomain },
      data: input.data,
    };
    let eventId: string;
    try {
      // The event and its deliveries together: an event row left without them would hold its dedupe key
      // and turn every later report of the same happening away, so it would never be sent.
      eventId = await systemDb.$transaction(async (tx) => {
        const row = await tx.zapierEvent.create({
          data: { workspaceId: input.workspaceId, storeId: input.storeId, event: input.event, hookId: input.hookId ?? null, dedupeKey: input.dedupeKey, payload: envelope as unknown as Prisma.InputJsonValue },
        });
        await tx.zapierDelivery.createMany({
          data: allowed.map((h) => ({ workspaceId: input.workspaceId, storeId: input.storeId, eventId: row.id, hookId: h.id, event: input.event, nextAttemptAt: now })),
          skipDuplicates: true,
        });
        return row.id;
      });
    } catch (err) {
      // Written already (the same happening reported again): nothing more to send.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return 0;
      throw err;
    }
    if (queues) await enqueueEventDeliveries(eventId, queues, now);
    return allowed.length;
  } catch (err) {
    logger.error({ err, storeId: input.storeId, event: input.event }, "zapier event not recorded");
    return 0;
  }
}

/** Queue every delivery of one event that hasn't been yet. */
async function enqueueEventDeliveries(eventId: string, queues: Pick<Queues, "sync">, now: Date) {
  const rows = await systemDb.zapierDelivery.findMany({ where: { eventId, status: "pending", enqueuedAt: null }, select: { id: true } });
  for (const r of rows) {
    try {
      await zapierQueue(queues).send({ kind: "zapier", deliveryId: r.id });
      await systemDb.zapierDelivery.update({ where: { id: r.id }, data: { enqueuedAt: now } });
    } catch (err) {
      // The sweep sends whatever is due and was never queued.
      logger.warn({ err, deliveryId: r.id }, "zapier delivery not queued; the sweep will send it");
    }
  }
}

// ---------------------------------------------------------------------------
// The events
// ---------------------------------------------------------------------------

/**
 * "New alert": an alert as the bell words it (describeAlert), never its internal message, with the
 * page that fixes it. An alert about no store goes to the triggers of every store of the workspace.
 */
export function alertEventData(alert: { id: string; code: string; severity: string; message: string; createdAt: Date }): Record<string, unknown> {
  const w = describeAlert(alert);
  return { alert_id: alert.id, severity: w.severity, area: w.area, title: w.title, body: w.body, fix_url: `${env().APP_URL}${ALERT_PATH[w.area]}`, raised_at: alert.createdAt.toISOString() };
}

export async function zapierAlertRaised(
  alert: { id: string; workspaceId: string; storeId: string | null; code: string; severity: string; message: string; createdAt: Date },
  queues?: Pick<Queues, "sync">,
): Promise<void> {
  try {
    const stores = alert.storeId
      ? [alert.storeId]
      : (await systemDb.zapierHook.findMany({ where: { workspaceId: alert.workspaceId, event: "alert_raised", grant: { revokedAt: null } }, select: { storeId: true }, distinct: ["storeId"] })).map((h) => h.storeId);
    const data = alertEventData(alert);
    for (const storeId of stores) {
      await recordZapierEvent({ workspaceId: alert.workspaceId, storeId, event: "alert_raised", dedupeKey: `alert_raised:${alert.id}:${storeId}`, data, occurredAt: alert.createdAt }, queues);
    }
  } catch (err) {
    logger.error({ err, alertId: alert.id }, "zapier alert event not recorded");
  }
}

/** "WhatsApp message failed": what failed and why, with the customer's number masked (as stored), never in full. */
export function whatsappFailedData(m: Pick<WappMessage, "id" | "source" | "type" | "category" | "phoneMasked" | "reason" | "errorCode" | "campaignId" | "automationId">, at: Date): Record<string, unknown> {
  const reason = (m.reason ?? "provider_rejected") as WaSkipReason;
  return {
    message_id: m.id,
    source: m.source,
    type: m.type,
    category: m.category,
    phone_masked: m.phoneMasked,
    reason,
    reason_text: WA_SKIP_LABEL[reason] ?? "WhatsApp refused it",
    automation_id: m.automationId,
    campaign_id: m.campaignId,
    failed_at: at.toISOString(),
    view_url: `${env().APP_URL}/dashboard/whatsapp-automation`,
  };
}

/** Called once a WhatsApp message to a customer has failed: a send Meta refused or that gave up, or Meta reporting it failed (whatsapp/messages.ts). */
export async function zapierWhatsappFailed(m: Pick<WappMessage, "id" | "workspaceId" | "storeId" | "direction" | "source" | "type" | "category" | "phoneMasked" | "campaignId" | "automationId">, at: Date, queues?: Pick<Queues, "sync">): Promise<void> {
  // The team's own messages (tests, codes, alerts to the team) aren't about a customer.
  if (m.direction !== "out" || ["test", "verification", "team_alert"].includes(m.source)) return;
  await recordZapierEvent(
    { workspaceId: m.workspaceId, storeId: m.storeId, event: "whatsapp_message_failed", dedupeKey: `whatsapp_message_failed:${m.id}`, data: whatsappFailedData({ ...m, reason: "provider_rejected", errorCode: "whatsapp_error" }, at), occurredAt: at },
    queues,
  );
}

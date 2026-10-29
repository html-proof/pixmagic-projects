/**
 * Settings → Integrations' Zapier card: the store's connections (who allowed each, when, its last use,
 * its triggers), the last deliveries with their outcome, Disconnect, and Retry for a delivery that
 * failed. And the removals that go with a store's data (purgeStoreData).
 */
import { systemDb } from "@app/db";
import { deliveryOutcome, ZAPIER_EVENT_INFO, type ZapierEvent } from "@app/shared/zapier";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import type { Queues } from "../queues.js";
import { zapierQueue } from "./common.js";
import { zapierConfig } from "./config.js";
import { revokeZapierGrants } from "./oauth.js";

/** The deliveries the card lists. */
const RECENT_DELIVERIES = 20;

export async function zapierOverview(workspaceId: string, storeId: string, opts: { setup: boolean }) {
  const config = zapierConfig();
  const grants = await systemDb.zapierGrant.findMany({
    where: { workspaceId, storeId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    include: { hooks: { orderBy: { createdAt: "asc" } } },
  });
  const users = await systemDb.user.findMany({ where: { id: { in: [...new Set(grants.map((g) => g.userId))] } }, select: { id: true, email: true, displayName: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  const deliveries = await systemDb.zapierDelivery.findMany({ where: { workspaceId, storeId }, orderBy: { createdAt: "desc" }, take: RECENT_DELIVERIES });
  return {
    configured: config.configured,
    inviteUrl: config.configured ? config.inviteUrl : null,
    // Which settings are set (never their values), for the owners' setup checklist.
    setup: opts.setup ? config.settings : null,
    connections: grants.map((g) => ({
      id: g.id,
      authorizedBy: byId.get(g.userId) ? { email: byId.get(g.userId)!.email, name: byId.get(g.userId)!.displayName } : null,
      createdAt: g.createdAt.toISOString(),
      lastUsedAt: g.lastUsedAt?.toISOString() ?? null,
      // What it may do beyond triggers and searches (whatsapp_send: the "Send WhatsApp Template Message" action).
      scopes: g.scopes,
      triggers: g.hooks.map((h) => ({
        id: h.id,
        event: h.event,
        label: ZAPIER_EVENT_INFO[h.event as ZapierEvent]?.label ?? h.event,
        inputs: h.inputs,
        createdAt: h.createdAt.toISOString(),
        lastDeliveredAt: h.lastDeliveredAt?.toISOString() ?? null,
        checkedAt: h.checkedAt?.toISOString() ?? null,
        // A threshold that can't be checked: its accounts report in several currencies.
        mixedCurrencies: h.checkNote?.startsWith("mixed_currencies:") ? h.checkNote.slice("mixed_currencies:".length).split(",") : null,
      })),
    })),
    deliveries: deliveries.map((d) => ({
      id: d.id,
      event: d.event,
      eventLabel: ZAPIER_EVENT_INFO[d.event as ZapierEvent]?.label ?? d.event,
      status: d.status,
      // label, tone and reason: how the outcome reads.
      ...deliveryOutcome(d),
      attempts: d.attempts,
      createdAt: d.createdAt.toISOString(),
      lastAttemptAt: d.lastAttemptAt?.toISOString() ?? null,
      deliveredAt: d.deliveredAt?.toISOString() ?? null,
      nextAttemptAt: d.status === "retrying" ? d.nextAttemptAt.toISOString() : null,
      // Failed, and its trigger is still there to send it to (Retry).
      retryable: d.status === "failed" && !!d.hookId,
    })),
  };
}

export type ZapierRetryOutcome = "queued" | "not_found" | "not_failed" | "trigger_gone";

/**
 * Retry (owners and admins): send a failed delivery again, as if new: its attempts start over and
 * the member behind the connection is checked again at delivery. Only a failed one whose trigger is
 * still there (a Zap turned off or Zapier disconnected has nowhere to send it).
 */
export async function retryZapierDelivery(
  workspaceId: string,
  storeId: string,
  deliveryId: string,
  queues: Pick<Queues, "sync">,
  actor: { userId: string; ip?: string },
  now = new Date(),
): Promise<ZapierRetryOutcome> {
  const d = await systemDb.zapierDelivery.findFirst({ where: { id: deliveryId, workspaceId, storeId }, include: { hook: { include: { grant: true } } } });
  if (!d) return "not_found";
  if (d.status !== "failed") return "not_failed";
  if (!d.hook || d.hook.grant.revokedAt) return "trigger_gone";
  // Conditional: two clicks at once queue it once.
  const reset = await systemDb.zapierDelivery.updateMany({
    where: { id: d.id, status: "failed" },
    data: { status: "pending", attempts: 0, nextAttemptAt: now, errorCode: null, responseStatus: null, enqueuedAt: null },
  });
  if (!reset.count) return "not_failed";
  try {
    await zapierQueue(queues).send({ kind: "zapier", deliveryId: d.id });
    await systemDb.zapierDelivery.update({ where: { id: d.id }, data: { enqueuedAt: now } });
  } catch (err) {
    // Pending and due: the cron sweep sends it.
    logger.warn({ err, deliveryId: d.id }, "zapier retry not queued; the sweep will send it");
  }
  await audit({ workspaceId, actorUserId: actor.userId, action: "zapier.delivery_retried", targetType: "zapier_delivery", targetId: d.id, metadata: { storeId, event: d.event, hookId: d.hookId }, ip: actor.ip });
  return "queued";
}

/** Disconnect one Zapier connection of the store: its tokens stop working and its triggers are deleted. */
export async function disconnectZapier(workspaceId: string, storeId: string, grantId: string, actor: { userId: string; ip?: string }): Promise<boolean> {
  const grant = await systemDb.zapierGrant.findFirst({ where: { id: grantId, workspaceId, storeId, revokedAt: null } });
  if (!grant) return false;
  await revokeZapierGrants({ id: grant.id }, "disconnected");
  await audit({ workspaceId, actorUserId: actor.userId, action: "zapier.disconnected", targetType: "zapier_grant", targetId: grant.id, metadata: { storeId }, ip: actor.ip });
  return true;
}

/** Erasing a store: its Zapier connections, triggers and outbox, for purgeStoreData's one transaction (tokens go with their grants). */
export function purgeZapierStoreOps(storeId: string) {
  return [
    systemDb.zapierDelivery.deleteMany({ where: { storeId } }),
    systemDb.zapierEvent.deleteMany({ where: { storeId } }),
    systemDb.zapierHook.deleteMany({ where: { storeId } }),
    systemDb.zapierGrant.deleteMany({ where: { storeId } }),
  ];
}

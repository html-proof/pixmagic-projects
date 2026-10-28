/**
 * Settings → Integrations' Zapier card: the store's connections (who allowed each, when, its last use,
 * its triggers), the last deliveries with their outcome, and Disconnect. And the removals that go with
 * a store's data (purgeStoreData).
 */
import { systemDb } from "@app/db";
import { deliveryOutcome, ZAPIER_EVENT_INFO, type ZapierEvent } from "@app/shared/zapier";
import { audit } from "../notify.js";
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
    })),
  };
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

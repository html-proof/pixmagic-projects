/**
 * Zapier's REST hooks: a Zap turned on subscribes its trigger (POST /api/zapier/hooks) with the
 * address Zapier gave it; turned off, it unsubscribes. And the trigger's samples, which Zapier shows
 * while the Zap is being set up: the store's last few real events, never made-up data.
 */
import { systemDb, toNumber, type Prisma, type ZapierGrant, type ZapierHook } from "@app/db";
import type { AccessKey } from "@app/shared";
import { z } from "zod";
import {
  isZapierHookUrl,
  ZAPIER_DIRECTIONS,
  ZAPIER_EVENT_INFO,
  ZAPIER_MAX_HOOKS_PER_GRANT,
  ZAPIER_PERIODS,
  ZAPIER_SCHEMA_VERSION,
  ZAPIER_SPEND_PLATFORMS,
  type ZapierEvent,
} from "@app/shared/zapier";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import { eventAllowed, eventDataAllowed, redactFor, type AuthorizerAccess } from "./access.js";
import { summarySample, syncCompletedData, syncCompletedKey } from "./ads.js";
import { ZapierError, type ZapierEnvelope } from "./common.js";
import { alertEventData, integrationChange, integrationEventData, INTEGRATION_AUDIT_ACTIONS, orderPaidData, whatsappFailedData } from "./events.js";

const targetUrl = z.string().max(2000);
const zapId = z.union([z.string(), z.number()]).transform(String).optional();
const threshold = { period: z.enum(ZAPIER_PERIODS), amount: z.coerce.number().positive().max(1_000_000_000) };

/** What a subscription may carry, per trigger: the address, and a threshold's own fields. */
export const hookInputSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("alert_raised"), targetUrl, zapId }),
  z.object({ event: z.literal("ad_spend_threshold"), targetUrl, zapId, platform: z.enum(ZAPIER_SPEND_PLATFORMS).default("any"), ...threshold }),
  // "below": once a finished day or month ended under the amount (ads.ts checkZapierThresholds).
  z.object({ event: z.literal("adsense_earnings_threshold"), targetUrl, zapId, ...threshold, direction: z.enum(ZAPIER_DIRECTIONS).default("above") }),
  z.object({ event: z.literal("ads_daily_summary"), targetUrl, zapId }),
  z.object({ event: z.literal("whatsapp_message_failed"), targetUrl, zapId }),
  z.object({ event: z.literal("integration_connected"), targetUrl, zapId }),
  z.object({ event: z.literal("integration_disconnected"), targetUrl, zapId }),
  z.object({ event: z.literal("sync_completed"), targetUrl, zapId }),
  z.object({ event: z.literal("order_paid"), targetUrl, zapId }),
]);
export type HookInput = z.infer<typeof hookInputSchema>;

/** What a member lacking a trigger's permission can't see, and the permission's name in Team & Access. */
const MISSING: Partial<Record<AccessKey, [string, string]>> = {
  "marketing.ads": ["advertising figures", "View advertising analytics"],
  "marketing.campaigns": ["WhatsApp messages", "View campaigns and their performance"],
  "integrations.status": ["the store's connected accounts", "View integration connection status"],
  "analytics.sales": ["the store's sales", "View sales and revenue"],
};

/** The permission a trigger needs, refused in the words Zapier shows the person setting up the Zap. */
function assertEventAllowed(event: ZapierEvent, who: AuthorizerAccess) {
  if (!eventAllowed(event, who)) {
    const [what, permission] = MISSING[ZAPIER_EVENT_INFO[event].needs!] ?? ["this", "the permission it needs"];
    throw new ZapierError(`The person who connected bizinsights can't see ${what} in this workspace. An owner or admin can give them "${permission}" in Team & Access.`, 403, "no_permission");
  }
}

/** Subscribe a Zap's trigger. Refused for an address that isn't Zapier's own (SSRF) or a trigger the member may not have. */
export async function subscribeZapierHook(grant: ZapierGrant, who: AuthorizerAccess, input: HookInput): Promise<ZapierHook> {
  assertEventAllowed(input.event, who);
  if (!isZapierHookUrl(input.targetUrl)) {
    throw new ZapierError("bizinsights sends events only to Zapier's own addresses (https://hooks.zapier.com/hooks/…).", 400, "invalid_target");
  }
  const count = await systemDb.zapierHook.count({ where: { grantId: grant.id } });
  if (count >= ZAPIER_MAX_HOOKS_PER_GRANT) {
    throw new ZapierError(`This connection already has ${ZAPIER_MAX_HOOKS_PER_GRANT} bizinsights triggers. Turn off Zaps you no longer use, or connect bizinsights again.`, 409, "too_many_hooks");
  }
  const { event, targetUrl: url, zapId: zap, ...inputs } = input;
  const hook = await systemDb.zapierHook.create({
    data: { workspaceId: grant.workspaceId, storeId: grant.storeId, grantId: grant.id, event, targetUrl: url, zapId: zap?.slice(0, 100) ?? null, inputs: inputs as Prisma.InputJsonValue },
  });
  logger.info({ hookId: hook.id, grantId: grant.id, event }, "zapier trigger subscribed");
  // The member's Zap, set up in their Zapier account: theirs in the log.
  await audit({ workspaceId: grant.workspaceId, actorUserId: grant.userId, action: "zapier.trigger_subscribed", targetType: "zapier_hook", targetId: hook.id, metadata: { grantId: grant.id, storeId: grant.storeId, event, zapId: hook.zapId } });
  return hook;
}

/** Unsubscribe one of this connection's triggers. False: no such trigger here (another connection's is never found). */
export async function unsubscribeZapierHook(grant: ZapierGrant, hookId: string): Promise<boolean> {
  const hook = await systemDb.zapierHook.findFirst({ where: { id: hookId, grantId: grant.id } });
  if (!hook) return false;
  await systemDb.zapierDelivery.updateMany({ where: { hookId: hook.id, status: { in: ["pending", "retrying"] } }, data: { status: "cancelled", errorCode: "hook_removed" } });
  await systemDb.zapierHook.delete({ where: { id: hook.id } });
  logger.info({ hookId: hook.id, grantId: grant.id, event: hook.event }, "zapier trigger unsubscribed");
  await audit({ workspaceId: grant.workspaceId, actorUserId: grant.userId, action: "zapier.trigger_unsubscribed", targetType: "zapier_hook", targetId: hook.id, metadata: { grantId: grant.id, storeId: grant.storeId, event: hook.event, zapId: hook.zapId } });
  return true;
}

const SAMPLES = 3;

/**
 * A trigger's samples: the store's last few events of the kind, as this member would receive them.
 * With none sent yet, the store's own recent ones: its latest alerts, failed WhatsApp messages,
 * yesterday's stored advertising figures, integrations connected or disconnected, ad accounts' last
 * syncs, or paid orders. Thresholds have none until one is crossed: an empty list.
 */
export async function zapierSamples(grant: ZapierGrant, who: AuthorizerAccess, event: ZapierEvent, now = new Date()): Promise<ZapierEnvelope[]> {
  assertEventAllowed(event, who);
  const storeRef = { id: who.store.id, name: who.store.name ?? who.store.shopDomain, shop_domain: who.store.shopDomain };
  const envelope = (id: string, data: Record<string, unknown>, at: Date): ZapierEnvelope => ({
    id,
    event,
    schema_version: ZAPIER_SCHEMA_VERSION,
    occurred_at: at.toISOString(),
    store: storeRef,
    data: redactFor(event, data, who),
  });
  // Events meant for one trigger only (a threshold's) are that trigger's: not another connection's samples.
  const own = (await systemDb.zapierHook.findMany({ where: { grantId: grant.id }, select: { id: true } })).map((h) => h.id);
  const sent = await systemDb.zapierEvent.findMany({
    where: { storeId: grant.storeId, event, OR: [{ hookId: null }, { hookId: { in: own } }] },
    orderBy: { createdAt: "desc" },
    take: SAMPLES * 4,
  });
  const fromSent = sent
    .map((e) => e.payload as unknown as ZapierEnvelope)
    // An alert this member couldn't see in the bell isn't theirs to sample either.
    .filter((p) => eventDataAllowed(event, p.data, who))
    .slice(0, SAMPLES)
    .map((p) => envelope(p.id, p.data, new Date(p.occurred_at)));
  if (fromSent.length) return fromSent;
  if (event === "alert_raised") {
    const alerts = await systemDb.alert.findMany({ where: { workspaceId: grant.workspaceId, OR: [{ storeId: grant.storeId }, { storeId: null }] }, orderBy: { createdAt: "desc" }, take: SAMPLES * 4 });
    return alerts
      .map((a) => ({ a, data: alertEventData(a) }))
      .filter(({ data }) => eventDataAllowed(event, data, who))
      .slice(0, SAMPLES)
      .map(({ a, data }) => envelope(`alert_raised:${a.id}:${grant.storeId}`, data, a.createdAt));
  }
  if (event === "whatsapp_message_failed") {
    const failed = await systemDb.wappMessage.findMany({
      where: { storeId: grant.storeId, direction: "out", status: "failed", source: { notIn: ["test", "verification", "team_alert"] } },
      orderBy: { failedAt: "desc" },
      take: SAMPLES,
    });
    return failed.map((m) => envelope(`whatsapp_message_failed:${m.id}`, whatsappFailedData(m, m.failedAt ?? m.updatedAt), m.failedAt ?? m.updatedAt));
  }
  if (event === "ads_daily_summary") {
    const s = await summarySample(grant.storeId, who, now);
    return s ? [envelope(s.dedupeKey, s.data, now)] : [];
  }
  if (event === "integration_connected" || event === "integration_disconnected") {
    const rows = await systemDb.auditLog.findMany({ where: { workspaceId: grant.workspaceId, action: { in: INTEGRATION_AUDIT_ACTIONS } }, orderBy: { createdAt: "desc" }, take: 50 });
    return rows
      .map((row) => ({ row, change: integrationChange(row) }))
      .filter(({ change }) => change?.event === event && change.storeId === grant.storeId)
      .slice(0, SAMPLES)
      .map(({ row, change }) => envelope(`${event}:${row.id}`, integrationEventData(change!, row, row.createdAt), row.createdAt));
  }
  if (event === "sync_completed") {
    const conns = await systemDb.adConnection.findMany({
      where: { storeId: grant.storeId, enabled: true, isDemo: false, lastSyncedAt: { not: null } },
      orderBy: { lastSyncedAt: "desc" },
      take: SAMPLES,
      select: { id: true, provider: true, accountId: true, accountName: true, lastSyncedAt: true, syncedThrough: true },
    });
    return conns.flatMap((c) => {
      const data = syncCompletedData(c, c.lastSyncedAt!);
      return data ? [envelope(syncCompletedKey(c.id, c.lastSyncedAt!), data, c.lastSyncedAt!)] : [];
    });
  }
  if (event === "order_paid") {
    const orders = await systemDb.order.findMany({
      where: { storeId: grant.storeId, financialStatus: "paid", cancelledAt: null },
      orderBy: { shopifyCreatedAt: "desc" },
      take: SAMPLES,
      include: { lineItems: true },
    });
    return orders.map((o) =>
      envelope(
        `order_paid:${grant.storeId}:${o.shopifyId}`,
        orderPaidData({
          shopifyId: o.shopifyId,
          name: o.name,
          currency: o.currency,
          totalPrice: toNumber(o.totalPrice),
          subtotal: toNumber(o.subtotal),
          totalDiscounts: toNumber(o.totalDiscounts),
          totalTax: toNumber(o.totalTax),
          totalShipping: toNumber(o.totalShipping),
          financialStatus: o.financialStatus,
          sourceName: o.sourceName,
          processedAt: o.shopifyProcessedAt ?? o.shopifyCreatedAt,
          lineItems: o.lineItems.map((li) => ({ productShopifyId: li.productShopifyId, variantShopifyId: li.variantShopifyId, sku: li.sku, title: li.title, quantity: li.quantity, price: toNumber(li.price) })),
        }),
        o.shopifyProcessedAt ?? o.shopifyCreatedAt,
      ),
    );
  }
  return [];
}

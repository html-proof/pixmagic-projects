/**
 * Zapier's REST hooks: a Zap turned on subscribes its trigger (POST /api/zapier/hooks) with the
 * address Zapier gave it; turned off, it unsubscribes. And the trigger's samples, which Zapier shows
 * while the Zap is being set up: the store's last few real events, never made-up data.
 */
import { systemDb, type Prisma, type ZapierGrant, type ZapierHook } from "@app/db";
import { z } from "zod";
import { isZapierHookUrl, ZAPIER_MAX_HOOKS_PER_GRANT, ZAPIER_PERIODS, ZAPIER_SPEND_PLATFORMS, type ZapierEvent } from "@app/shared/zapier";
import { logger } from "../logger.js";
import { eventAllowed, eventDataAllowed, redactFor, type AuthorizerAccess } from "./access.js";
import { summarySample } from "./ads.js";
import { ZapierError, type ZapierEnvelope } from "./common.js";
import { alertEventData, whatsappFailedData } from "./events.js";

const targetUrl = z.string().max(2000);
const zapId = z.union([z.string(), z.number()]).transform(String).optional();
const threshold = { period: z.enum(ZAPIER_PERIODS), amount: z.coerce.number().positive().max(1_000_000_000) };

/** What a subscription may carry, per trigger: the address, and a threshold's own fields. */
export const hookInputSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("alert_raised"), targetUrl, zapId }),
  z.object({ event: z.literal("ad_spend_threshold"), targetUrl, zapId, platform: z.enum(ZAPIER_SPEND_PLATFORMS).default("any"), ...threshold }),
  z.object({ event: z.literal("adsense_earnings_threshold"), targetUrl, zapId, ...threshold }),
  z.object({ event: z.literal("ads_daily_summary"), targetUrl, zapId }),
  z.object({ event: z.literal("whatsapp_message_failed"), targetUrl, zapId }),
]);
export type HookInput = z.infer<typeof hookInputSchema>;

/** The permission a trigger needs, refused in the words Zapier shows the person setting up the Zap. */
function assertEventAllowed(event: ZapierEvent, who: AuthorizerAccess) {
  if (!eventAllowed(event, who)) {
    throw new ZapierError(
      event === "whatsapp_message_failed"
        ? "The person who connected bizinsights can't see WhatsApp messages in this workspace. An owner or admin can give them \"View campaigns and their performance\" in Team & Access."
        : "The person who connected bizinsights can't see advertising figures in this workspace. An owner or admin can give them \"View advertising analytics\" in Team & Access.",
      403,
      "no_permission",
    );
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
  return hook;
}

/** Unsubscribe one of this connection's triggers. False: no such trigger here (another connection's is never found). */
export async function unsubscribeZapierHook(grant: ZapierGrant, hookId: string): Promise<boolean> {
  const hook = await systemDb.zapierHook.findFirst({ where: { id: hookId, grantId: grant.id } });
  if (!hook) return false;
  await systemDb.zapierDelivery.updateMany({ where: { hookId: hook.id, status: { in: ["pending", "retrying"] } }, data: { status: "cancelled", errorCode: "hook_removed" } });
  await systemDb.zapierHook.delete({ where: { id: hook.id } });
  logger.info({ hookId: hook.id, grantId: grant.id, event: hook.event }, "zapier trigger unsubscribed");
  return true;
}

const SAMPLES = 3;

/**
 * A trigger's samples: the store's last few events of the kind, as this member would receive them.
 * With none sent yet, the store's own recent ones: its latest alerts, failed WhatsApp messages, or
 * yesterday's stored advertising figures. Thresholds have none until one is crossed: an empty list.
 */
export async function zapierSamples(grant: ZapierGrant, who: AuthorizerAccess, event: ZapierEvent, now = new Date()): Promise<ZapierEnvelope[]> {
  assertEventAllowed(event, who);
  const storeRef = { id: who.store.id, name: who.store.name ?? who.store.shopDomain, shop_domain: who.store.shopDomain };
  const envelope = (id: string, data: Record<string, unknown>, at: Date): ZapierEnvelope => ({ id, event, occurred_at: at.toISOString(), store: storeRef, data: redactFor(event, data, who) });
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
  return [];
}

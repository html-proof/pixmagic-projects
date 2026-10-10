/**
 * Marketing campaigns. A campaign only ever goes to customers who opted in to WhatsApp marketing
 * and haven't opted out, and only after a merchant scheduled it and confirmed the recipient count.
 * Recipients are chosen when the campaign starts (not when it was written), so anyone who opted
 * out in between is left out, and each message checks consent again right before it is sent.
 */
import { Prisma, systemDb, type Store, type WhatsappCampaign } from "@app/db";
import { audienceSchema, OCCASIONS, templateMappingSchema, type Audience, type WhatsappConfig } from "@app/shared";
import { logger } from "../logger.js";
import { cancelScheduled, messageRow, waQueue, type WaDeps } from "./messages.js";
import { contactFirstName, parseConfig } from "./store.js";
import { storeName } from "./values.js";

/** Contacts a campaign with this audience would go to right now. */
export async function audienceContactIds(storeId: string, audience: Audience, cfg: WhatsappConfig, limit = 100_000): Promise<string[]> {
  const days = Math.max(1, audience.days);
  const since = new Date(Date.now() - days * 86_400_000);
  const segment =
    audience.segment === "recent_buyers" ? Prisma.sql`AND o.last_order >= ${since}`
    : audience.segment === "lapsed_buyers" ? Prisma.sql`AND o.last_order IS NOT NULL AND o.last_order < ${since}`
    : audience.segment === "repeat_buyers" ? Prisma.sql`AND COALESCE(o.orders, 0) >= 2`
    : audience.segment === "high_spenders" ? Prisma.sql`AND COALESCE(o.spent, 0) >= ${audience.minSpend}`
    : Prisma.empty;
  const countries = audience.countries.length ? Prisma.sql`AND c.country IN (${Prisma.join(audience.countries)})` : Prisma.empty;
  // Shopify's SMS consent counts only when the merchant said their wording covers WhatsApp.
  const source = cfg.smsConsentCountsForMarketing ? Prisma.empty : Prisma.sql`AND COALESCE(c.marketing_source, '') <> 'shopify_sms'`;
  const rows = await systemDb.$queryRaw<Array<{ id: string }>>`
    SELECT c.id FROM whatsapp_contacts c
    LEFT JOIN (
      SELECT contact_id, COUNT(*)::int AS orders, SUM(total_price) AS spent, MAX(order_created_at) AS last_order
      FROM order_trackings WHERE store_id = ${storeId} AND cancelled_at IS NULL AND contact_id IS NOT NULL
      GROUP BY contact_id
    ) o ON o.contact_id = c.id
    WHERE c.store_id = ${storeId} AND c.opted_out = false AND c.marketing_status = 'opted_in'
    ${source} ${segment} ${countries}
    ORDER BY c.created_at
    LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

export async function estimateAudience(storeId: string, audience: unknown, cfg: WhatsappConfig) {
  return (await audienceContactIds(storeId, audienceSchema.parse(audience ?? {}), cfg)).length;
}

export interface CampaignVariables {
  greeting?: string;
  discountPercentage?: string;
  endDate?: string;
}

function campaignValues(store: Store, c: WhatsappCampaign) {
  const v = (c.variables ?? {}) as CampaignVariables;
  const occasion = OCCASIONS.find((o) => o.id === c.occasion);
  return {
    store_name: storeName(store),
    occasion: v.greeting || occasion?.greeting || c.name,
    discount_percentage: v.discountPercentage ?? null,
    end_date: v.endDate ?? (c.endAt ? c.endAt.toISOString().slice(0, 10) : null),
    discount_code: c.discountCode ?? null,
  };
}

const BATCH = 500;

/**
 * Turn a due campaign into its messages (one per recipient, at most once each), then hand them
 * to the dispatcher. Returns the number of recipients.
 */
export async function startCampaign(campaign: WhatsappCampaign, deps: WaDeps): Promise<number> {
  const [store, settings] = await Promise.all([
    systemDb.store.findUnique({ where: { id: campaign.storeId } }),
    systemDb.whatsappSettings.findUnique({ where: { storeId: campaign.storeId } }),
  ]);
  if (!store || !settings) return 0;
  // Claim it: only one sweeper turns it into messages.
  const { count } = await systemDb.whatsappCampaign.updateMany({ where: { id: campaign.id, status: "scheduled" }, data: { status: "sending", startedAt: new Date() } });
  if (!count) return 0;
  const cfg = parseConfig(settings.config);
  const ids = await audienceContactIds(store.id, audienceSchema.parse(campaign.audience ?? {}), cfg);
  const mapping = templateMappingSchema.parse(campaign.mapping ?? {});
  const base = campaignValues(store, campaign);
  const now = new Date();
  for (let i = 0; i < ids.length; i += BATCH) {
    const contacts = await systemDb.whatsappContact.findMany({ where: { id: { in: ids.slice(i, i + BATCH) } } });
    const rows = contacts.map((contact) =>
      messageRow({
        store,
        kind: "campaign",
        dedupeKey: `campaign:${campaign.id}:${contact.id}`,
        contact,
        template: { name: campaign.templateName, language: campaign.templateLanguage },
        mapping,
        values: { ...base, customer_name: contactFirstName(contact) || "there" },
        media: campaign.mediaUrl ? { link: campaign.mediaUrl } : null,
        scheduledFor: now,
        campaignId: campaign.id,
        clickUrl: campaign.linkUrl,
      }),
    );
    await systemDb.whatsappMessage.createMany({ data: rows, skipDuplicates: true });
  }
  await systemDb.whatsappCampaign.update({ where: { id: campaign.id }, data: { estimatedRecipients: ids.length } });
  if (ids.length) await waQueue(deps.queues).send({ kind: "whatsapp_dispatch", storeId: store.id });
  logger.info({ campaignId: campaign.id, recipients: ids.length }, "whatsapp campaign started");
  return ids.length;
}

/** Start due campaigns, end finished ones. Called on every sweeper tick. */
export async function advanceCampaigns(deps: WaDeps): Promise<{ started: number; finished: number }> {
  const now = new Date();
  let started = 0;
  const due = await systemDb.whatsappCampaign.findMany({ where: { status: "scheduled", startAt: { lte: now } }, take: 20 });
  for (const c of due) {
    if (c.endAt && c.endAt <= now) {
      await systemDb.whatsappCampaign.update({ where: { id: c.id }, data: { status: "completed", completedAt: now } });
      continue;
    }
    await startCampaign(c, deps);
    started++;
  }
  let finished = 0;
  const running = await systemDb.whatsappCampaign.findMany({ where: { status: { in: ["sending", "paused"] } }, select: { id: true, endAt: true, status: true } });
  for (const c of running) {
    if (c.endAt && c.endAt <= now) {
      await cancelScheduled({ campaignId: c.id }, "campaign_ended");
      await systemDb.whatsappCampaign.update({ where: { id: c.id }, data: { status: "completed", completedAt: now } });
      finished++;
      continue;
    }
    if (c.status !== "sending") continue;
    const left = await systemDb.whatsappMessage.count({ where: { campaignId: c.id, status: { in: ["scheduled", "sending"] } } });
    if (!left) {
      await systemDb.whatsappCampaign.update({ where: { id: c.id }, data: { status: "completed", completedAt: now } });
      finished++;
    }
  }
  return { started, finished };
}

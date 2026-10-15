/**
 * Marketing campaigns. A campaign only ever goes to customers who opted in to WhatsApp marketing
 * and haven't opted out, and only after a merchant scheduled it and confirmed the recipient count.
 * Recipients are chosen when the campaign starts (not when it was written), so anyone who opted
 * out in between is left out, and each message checks consent again right before it is sent.
 */
import { Prisma, systemDb, withTenant, type Store, type WhatsappCampaign } from "@app/db";
import {
  audienceSchema,
  campaignCan,
  campaignStatusAfter,
  OCCASIONS,
  templateMappingSchema,
  templateShape,
  type Audience,
  type CampaignAction,
  type CampaignStatus,
  type TemplateComponent,
  type WhatsappConfig,
} from "@app/shared";
import { logger } from "../logger.js";
import { WhatsappError } from "./errors.js";
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

export interface CampaignMetrics {
  recipients: number;
  /** Not sent yet (scheduled or being sent). */
  waiting: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  clicks: number;
  /** Orders attributed to a click on the campaign's link, and their revenue. */
  conversions: number;
  revenue: number;
  /** Orders that used the campaign's discount code while it ran and its attribution days after. */
  codeOrders: { orders: number; revenue: number } | null;
}

/** What each campaign achieved, for several campaigns at once (a few queries, not a few per campaign). */
export async function campaignMetrics(workspaceId: string, storeId: string, campaigns: WhatsappCampaign[], attributionDays: number): Promise<Map<string, CampaignMetrics>> {
  const ids = campaigns.map((x) => x.id);
  const out = new Map<string, CampaignMetrics>();
  if (!ids.length) return out;
  const [byStatus, clicks, attributed] = await withTenant(workspaceId, (tx) =>
    Promise.all([
      tx.whatsappMessage.groupBy({ by: ["campaignId", "status"], where: { campaignId: { in: ids }, workspaceId }, _count: { _all: true } }),
      tx.whatsappMessage.groupBy({ by: ["campaignId"], where: { campaignId: { in: ids }, workspaceId, clickedAt: { not: null } }, _count: { _all: true } }),
      tx.whatsappMessage.groupBy({ by: ["campaignId"], where: { campaignId: { in: ids }, workspaceId, attributedOrderId: { not: null } }, _count: { _all: true }, _sum: { attributedRevenue: true } }),
    ]),
  );
  // Orders that used each campaign's discount code while it ran (and its attribution days after),
  // for every campaign with a code at once: one query, not one per campaign.
  const now = Date.now();
  const windows = campaigns.flatMap((camp) =>
    camp.discountCode && camp.startedAt
      ? [{ id: camp.id, code: camp.discountCode, since: camp.startedAt.toISOString(), until: new Date((camp.endAt?.getTime() ?? now) + attributionDays * 86_400_000).toISOString() }]
      : [],
  );
  const codeRows = windows.length
    ? await withTenant(workspaceId, (tx) =>
        tx.$queryRaw<Array<{ id: string; orders: number; revenue: string }>>`
          SELECT w.id, COUNT(o.id)::int AS orders, COALESCE(SUM(o.total_price), 0)::text AS revenue
          FROM jsonb_to_recordset(${JSON.stringify(windows)}::jsonb) AS w(id text, code text, since text, until text)
          LEFT JOIN orders o
            ON o.store_id = ${storeId} AND o.workspace_id = ${workspaceId} AND o.cancelled_at IS NULL
           AND o.shopify_created_at >= (w.since)::timestamptz AT TIME ZONE 'UTC'
           AND o.shopify_created_at < (w.until)::timestamptz AT TIME ZONE 'UTC'
           AND EXISTS (SELECT 1 FROM unnest(o.discount_codes) code WHERE lower(code) = lower(w.code))
          GROUP BY w.id`,
      )
    : [];
  for (const camp of campaigns) {
    const n = (s: string[]) => byStatus.filter((b) => b.campaignId === camp.id && s.includes(b.status)).reduce((sum, b) => sum + b._count._all, 0);
    const a = attributed.find((x) => x.campaignId === camp.id);
    const r = codeRows.find((x) => x.id === camp.id);
    out.set(camp.id, {
      recipients: n(["scheduled", "sending", "sent", "delivered", "read", "failed", "skipped", "cancelled"]),
      waiting: n(["scheduled", "sending"]),
      sent: n(["sent", "delivered", "read"]),
      delivered: n(["delivered", "read"]),
      read: n(["read"]),
      failed: n(["failed"]),
      skipped: n(["skipped", "cancelled"]),
      clicks: clicks.find((x) => x.campaignId === camp.id)?._count._all ?? 0,
      conversions: a?._count._all ?? 0,
      revenue: Number(a?._sum.attributedRevenue ?? 0),
      codeOrders: r ? { orders: r.orders, revenue: Number(r.revenue) } : null,
    });
  }
  return out;
}

/**
 * Schedule (authorize) a draft campaign. The merchant confirms the recipient count they were
 * shown; if it changed since, nothing is scheduled and the new count comes back for them to
 * confirm. Needs an approved marketing template, a registered number and verified webhooks
 * (otherwise STOP replies couldn't reach us).
 */
export async function scheduleCampaign(
  camp: WhatsappCampaign,
  confirmRecipients: number,
  approvedByUserId: string,
): Promise<{ campaign: WhatsappCampaign; recipients: number } | { recipientsChanged: number }> {
  if (camp.status !== "draft") throw new WhatsappError("This campaign is already scheduled or has run.", 409, "not_draft");
  const storeId = camp.storeId;
  const [conn, settings] = await Promise.all([systemDb.whatsappConnection.findUnique({ where: { storeId } }), systemDb.whatsappSettings.findUnique({ where: { storeId } })]);
  if (!conn || conn.status !== "active" || !conn.registered) throw new WhatsappError("Connect and register your WhatsApp number first.", 409, "not_connected");
  if (!conn.webhookVerifiedAt) {
    throw new WhatsappError("Meta hasn't reached bizinsights' webhook yet, so opt-out replies couldn't be received. Finish the webhook step on Connect WhatsApp first.", 409, "webhook_unverified");
  }
  const template = await systemDb.whatsappTemplate.findUnique({ where: { connectionId_name_language: { connectionId: conn.id, name: camp.templateName, language: camp.templateLanguage } } });
  if (!template || template.status !== "APPROVED") throw new WhatsappError("The campaign's template isn't approved by Meta yet.", 409, "template_not_approved");
  if (template.category !== "MARKETING") throw new WhatsappError("Campaigns must use a template Meta approved as Marketing.", 409, "not_marketing_template");
  const shape = templateShape(template.components as unknown as TemplateComponent[]);
  const mapping = templateMappingSchema.parse(camp.mapping ?? {});
  if (mapping.body.length < shape.bodyVars) throw new WhatsappError(`The template has ${shape.bodyVars} variables; fill each one.`, 400, "mapping_incomplete");
  if (shape.headerFormat === "IMAGE" && !camp.mediaUrl) throw new WhatsappError("This template needs an image: add the image's https link.", 400, "media_required");
  if (shape.dynamicUrlButtons.length && !camp.linkUrl) throw new WhatsappError("This template has a link button: add where it should go.", 400, "link_required");
  if (camp.endAt && camp.endAt <= new Date()) throw new WhatsappError("The campaign's end has already passed.", 400, "ended");
  const estimate = await estimateAudience(storeId, camp.audience, parseConfig(settings?.config));
  if (estimate !== confirmRecipients) return { recipientsChanged: estimate };
  if (estimate === 0) throw new WhatsappError("No customers in this audience have opted in to WhatsApp marketing.", 409, "no_recipients");
  const campaign = await systemDb.whatsappCampaign.update({
    where: { id: camp.id },
    data: { status: "scheduled", estimatedRecipients: estimate, approvedByUserId, approvedAt: new Date() },
  });
  return { campaign, recipients: estimate };
}

/** Pause, resume or cancel a campaign. Cancelling also cancels its messages that haven't gone out. */
export async function changeCampaignState(camp: WhatsappCampaign, action: CampaignAction): Promise<CampaignStatus> {
  if (!campaignCan(camp.status, action)) throw new WhatsappError(`A ${camp.status} campaign can't be ${action === "cancel" ? "cancelled" : action + "d"}.`, 409, "invalid_state");
  const status = campaignStatusAfter(action, !!camp.startedAt);
  await systemDb.whatsappCampaign.update({ where: { id: camp.id }, data: { status, ...(action === "cancel" ? { completedAt: new Date() } : {}) } });
  if (action === "cancel") await cancelScheduled({ campaignId: camp.id }, "campaign_cancelled");
  return status;
}

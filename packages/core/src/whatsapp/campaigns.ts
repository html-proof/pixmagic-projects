/**
 * Campaigns (docs/whatsapp.md, "Campaigns"): a marketing template to the store's customers who agreed
 * to marketing messages, now or at a time, only after the merchant confirms the exact number of
 * recipients. Opening a page never sends anything: launching is its own request, which refuses when
 * the audience changed since the merchant saw its count.
 *
 * A campaign's recipients are its messages ("campaign:<id>:<contact>", unique per store), so a
 * batch made twice messages nobody twice. Messages are spread out as they are made (a linked phone
 * gets one every few seconds), go through the same sender and its checks (consent again, sending
 * hours, daily limits), and a cancelled campaign's waiting messages are cancelled with it. A linked
 * phone takes at most WA_CAMPAIGN_MAX.qr recipients: it isn't made for broadcasts.
 */
import { Prisma, systemDb, type Store, type WappCampaign, type WappTemplate } from "@app/db";
import {
  QR_GAP_JITTER_MS,
  QR_MIN_GAP_MS,
  CLOUD_SENDS_PER_SECOND,
  normalizePhone,
  renderWaText,
  variablesIn,
  waAudienceSchema,
  waCampaignSchema,
  waLaunchSchema,
  WaMissingValueError,
  waSetupProgress,
  WA_CAMPAIGN_MAX,
  type WaAudience,
  type WaProvider,
} from "@app/shared";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import { businessNameOf, liveConnection, settingsOf, storeById, WA_MAX_QUEUE_DELAY_S, waDecrypt, waQueue, WhatsappError, type WaDeps } from "./common.js";
import { contactFirstName } from "./contacts.js";
import { queueMessage } from "./messages.js";
import { templateUsable } from "./templates.js";

/** Recipients made per batch. */
const BATCH = 100;

/**
 * The audience's contacts as SQL (one statement for the count and the batches): opted in to
 * marketing, not opted out, not on the do-not-message list (everything or marketing), not found
 * missing from WhatsApp in the last 30 days, with a first name when the template greets customers by
 * it (so the count the merchant confirms is the messages made), plus the merchant's filters.
 */
function audienceSql(storeId: string, a: WaAudience, opts: { after?: string | null; limit?: number; count?: boolean; firstName?: boolean }) {
  const now = Date.now();
  const where: Prisma.Sql[] = [
    Prisma.sql`c.store_id = ${storeId}`,
    Prisma.sql`c.marketing = 'opted_in'`,
    Prisma.sql`c.opted_out = false`,
    Prisma.sql`(c.not_on_whatsapp_at IS NULL OR c.not_on_whatsapp_at < ${new Date(now - 30 * 86_400_000)})`,
    Prisma.sql`NOT EXISTS (SELECT 1 FROM wapp_suppressions s WHERE s.store_id = c.store_id AND s.phone_hash = c.phone_hash AND s.scope IN ('all', 'marketing'))`,
  ];
  if (a.countries.length) where.push(Prisma.sql`c.country IN (${Prisma.join(a.countries)})`);
  if (a.customerType === "new") where.push(Prisma.sql`c.orders_count = 1`);
  if (a.customerType === "returning") where.push(Prisma.sql`c.orders_count > 1`);
  if (a.orderedWithinDays) where.push(Prisma.sql`c.last_order_at >= ${new Date(now - a.orderedWithinDays * 86_400_000)}`);
  if (a.notOrderedForDays) where.push(Prisma.sql`(c.last_order_at IS NULL OR c.last_order_at < ${new Date(now - a.notOrderedForDays * 86_400_000)})`);
  if (a.minOrders) where.push(Prisma.sql`c.orders_count >= ${a.minOrders}`);
  if (a.minSpent != null) where.push(Prisma.sql`c.total_spent >= ${a.minSpent}`);
  if (opts.firstName) where.push(Prisma.sql`c.first_name_enc IS NOT NULL`);
  if (opts.after) where.push(Prisma.sql`c.id > ${opts.after}`);
  const cond = Prisma.join(where, " AND ");
  if (opts.count) return Prisma.sql`SELECT count(*)::int AS n FROM wapp_contacts c WHERE ${cond}`;
  return Prisma.sql`SELECT c.id FROM wapp_contacts c WHERE ${cond} ORDER BY c.id LIMIT ${opts.limit ?? BATCH}`;
}

/** Whether a template's text needs the customer's first name (contacts without one can't get it). */
const greetsByName = (t: Pick<WappTemplate, "body"> | null) => !!t && variablesIn(t.body).includes("customer_first_name");

/** How many customers the audience reaches now, for this template when one is picked. */
export async function estimateWaAudience(storeId: string, audience: unknown, template: Pick<WappTemplate, "body"> | null = null): Promise<number> {
  const a = waAudienceSchema.parse(audience);
  const rows = await systemDb.$queryRaw<Array<{ n: number }>>(audienceSql(storeId, a, { count: true, firstName: greetsByName(template) }));
  return rows[0]?.n ?? 0;
}

export async function saveCampaign(input: { store: Store; userId: string; id?: string; data: unknown; ip?: string }): Promise<WappCampaign> {
  const c = waCampaignSchema.parse(input.data);
  const template = await systemDb.wappTemplate.findFirst({ where: { id: c.templateId, storeId: input.store.id } });
  if (!template) throw new WhatsappError("Pick one of this store's templates.", 400, "template_not_found");
  if (template.category !== "marketing") throw new WhatsappError("Campaigns send marketing: pick a marketing template (it tells customers how to stop).", 400, "not_marketing");
  const unsupported = variablesIn(template.body).filter((v) => v !== "customer_first_name" && v !== "store_name");
  if (unsupported.length) throw new WhatsappError(`Campaigns can fill only {{customer_first_name}} and {{store_name}}; this template uses ${unsupported.map((v) => `{{${v}}}`).join(", ")}.`, 400, "unsupported_variables");
  const data = { name: c.name, templateId: c.templateId, audience: c.audience as unknown as Prisma.InputJsonValue };
  let row: WappCampaign;
  if (input.id) {
    const existing = await systemDb.wappCampaign.findFirst({ where: { id: input.id, storeId: input.store.id } });
    if (!existing) throw new WhatsappError("Not found", 404, "not_found");
    if (existing.status !== "draft") throw new WhatsappError("Only a draft campaign can be edited.", 409, "not_draft");
    row = await systemDb.wappCampaign.update({ where: { id: existing.id }, data });
  } else {
    row = await systemDb.wappCampaign.create({ data: { ...data, workspaceId: input.store.workspaceId, storeId: input.store.id, createdByUserId: input.userId } });
  }
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: input.id ? "whatsapp.campaign_updated" : "whatsapp.campaign_created", targetType: "whatsapp_campaign", targetId: row.id, ip: input.ip });
  return row;
}

export async function deleteCampaign(input: { store: Store; id: string; userId: string; ip?: string }) {
  const c = await systemDb.wappCampaign.findFirst({ where: { id: input.id, storeId: input.store.id } });
  if (!c) throw new WhatsappError("Not found", 404, "not_found");
  if (c.status === "scheduled" || c.status === "sending") throw new WhatsappError("Cancel the campaign before deleting it.", 409, "campaign_running");
  await systemDb.wappCampaign.delete({ where: { id: c.id } });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.campaign_deleted", targetType: "whatsapp_campaign", targetId: c.id, metadata: { name: c.name }, ip: input.ip });
}

/**
 * Launches a draft: now, or at `scheduledAt`. Refused unless every check passes and the audience
 * still has exactly the number of recipients the merchant confirmed.
 */
export async function launchCampaign(deps: Pick<WaDeps, "queues">, input: { store: Store; id: string; userId: string; data: unknown; ip?: string }): Promise<WappCampaign> {
  const l = waLaunchSchema.parse(input.data);
  const c = await systemDb.wappCampaign.findFirst({ where: { id: input.id, storeId: input.store.id } });
  if (!c) throw new WhatsappError("Not found", 404, "not_found");
  if (c.status !== "draft") throw new WhatsappError("This campaign has already been launched.", 409, "not_draft");
  const conn = await liveConnection(input.store.id);
  const settings = await settingsOf(input.store);
  const problems: string[] = [];
  if (!conn || conn.status !== "connected") problems.push("WhatsApp isn't connected.");
  const setup = waSetupProgress({ provider: (conn?.provider as WaProvider) ?? null, status: (conn?.status as "connected") ?? null, configuredAt: settings.configuredAt, orderUpdates: settings.orderUpdates, testVerifiedAt: settings.testVerifiedAt, testPassedAt: settings.testPassedAt });
  if (!setup.done.test) problems.push("Finish the setup's test step first.");
  if (!settings.marketingEnabled) problems.push("Marketing messages are switched off in Settings.");
  if (settings.automationPausedAt) problems.push("All automation is paused.");
  const template = await systemDb.wappTemplate.findFirst({ where: { id: c.templateId, storeId: input.store.id } });
  if (!template || template.category !== "marketing") problems.push("Pick a marketing template.");
  else if (!templateUsable(template, conn).ok) problems.push(`The template can't be used: ${templateUsable(template, conn).reason}`);
  if (problems.length) throw new WhatsappError("This campaign can't be launched yet.", 409, "campaign_blocked", { problems });
  const count = await estimateWaAudience(input.store.id, c.audience, template);
  if (count !== l.confirmRecipients) throw new WhatsappError(`The audience now has ${count} recipients, not ${l.confirmRecipients}. Check it and confirm again.`, 409, "count_changed", { count });
  if (count < 1) throw new WhatsappError("Nobody in this audience can receive marketing messages.", 409, "empty_audience");
  const max = WA_CAMPAIGN_MAX[conn!.provider as WaProvider];
  if (count > max) throw new WhatsappError(`A ${conn!.provider === "qr" ? "linked phone" : "connection"} can send a campaign to at most ${max} people. Narrow the audience.`, 409, "too_many_recipients", { count, max });
  const at = l.scheduledAt && l.scheduledAt.getTime() > Date.now() ? l.scheduledAt : new Date();
  const row = await systemDb.wappCampaign.update({ where: { id: c.id }, data: { status: "scheduled", scheduledAt: at, confirmedRecipients: count, launchedByUserId: input.userId, cursor: null, recipients: 0 } });
  const delay = Math.max(0, Math.ceil((at.getTime() - Date.now()) / 1000));
  if (delay <= WA_MAX_QUEUE_DELAY_S) await waQueue(deps.queues).send({ kind: "wapp_campaign", campaignId: c.id }, { delaySeconds: delay });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.campaign_launched", targetType: "whatsapp_campaign", targetId: c.id, metadata: { recipients: count, scheduledAt: at.toISOString() }, ip: input.ip });
  return row;
}

export async function cancelCampaign(input: { store: Store; id: string; userId: string; ip?: string }): Promise<{ campaign: WappCampaign; cancelled: number }> {
  const c = await systemDb.wappCampaign.findFirst({ where: { id: input.id, storeId: input.store.id } });
  if (!c) throw new WhatsappError("Not found", 404, "not_found");
  if (c.status !== "scheduled" && c.status !== "sending") throw new WhatsappError("Only a scheduled or sending campaign can be cancelled.", 409, "not_running");
  const row = await systemDb.wappCampaign.update({ where: { id: c.id }, data: { status: "cancelled", cancelledAt: new Date(), cancelReason: "merchant" } });
  const { count } = await systemDb.wappMessage.updateMany({ where: { campaignId: c.id, status: "queued" }, data: { status: "cancelled", reason: "campaign_cancelled", finalAt: new Date(), payloadEnc: null } });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.campaign_cancelled", targetType: "whatsapp_campaign", targetId: c.id, metadata: { cancelled: count }, ip: input.ip });
  return { campaign: row, cancelled: count };
}

/**
 * The worker's half (wapp_campaign): when due, the next batch of recipients becomes messages, each
 * timed a few seconds after the last; then the next batch, until the audience is done.
 */
export async function dispatchCampaign(deps: Pick<WaDeps, "queues">, campaignId: string): Promise<string> {
  const c = await systemDb.wappCampaign.findUnique({ where: { id: campaignId } });
  if (!c || (c.status !== "scheduled" && c.status !== "sending")) return "not_running";
  if (c.materializedAt) return "done";
  if (c.scheduledAt && c.scheduledAt.getTime() > Date.now() + 5_000) return "not_due";
  const store = await storeById(c.storeId);
  const conn = await liveConnection(c.storeId);
  if (!store || !conn || conn.status !== "connected") {
    // The sweep tries again; a connection down too long cancels the campaign there.
    return "not_connected";
  }
  if (c.status === "scheduled") await systemDb.wappCampaign.update({ where: { id: c.id }, data: { status: "sending", startedAt: new Date() } });
  const template = await systemDb.wappTemplate.findFirst({ where: { id: c.templateId, storeId: c.storeId } });
  if (!template || !templateUsable(template, conn).ok) {
    await systemDb.wappCampaign.update({ where: { id: c.id }, data: { status: "cancelled", cancelledAt: new Date(), cancelReason: "template_unavailable" } });
    return "template_unavailable";
  }
  const settings = await settingsOf(store);
  const audience = waAudienceSchema.parse(c.audience);
  const rows = await systemDb.$queryRaw<Array<{ id: string }>>(audienceSql(c.storeId, audience, { after: c.cursor, limit: BATCH, firstName: greetsByName(template) }));
  const contacts = rows.length ? await systemDb.wappContact.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: { id: "asc" } }) : [];
  const step = conn.provider === "qr" ? QR_MIN_GAP_MS + QR_GAP_JITTER_MS / 2 : Math.ceil(1000 / CLOUD_SENDS_PER_SECOND);
  // After the messages already made: a batch carries on where the last one's timing ended.
  const last = await systemDb.wappMessage.findFirst({ where: { campaignId: c.id }, orderBy: { sendAfter: "desc" }, select: { sendAfter: true } });
  let t = Math.max(Date.now(), (last?.sendAfter.getTime() ?? 0) + step);
  let made = 0;
  const cap = c.confirmedRecipients ?? WA_CAMPAIGN_MAX[conn.provider as WaProvider];
  for (const contact of contacts) {
    if (c.recipients + made >= cap) break;
    const phone = normalizePhone(waDecrypt(contact.storeId, "phone", contact.phoneEnc), null);
    if (!phone) continue;
    let text: string;
    try {
      text = renderWaText(template.body, { store_name: businessNameOf(store, settings), customer_first_name: contactFirstName(contact) ?? undefined });
    } catch (e) {
      if (e instanceof WaMissingValueError) continue;
      throw e;
    }
    const { created } = await queueMessage(deps, {
      store,
      conn,
      source: "campaign",
      category: "marketing",
      phone,
      contactId: contact.id,
      payload: { text, meta: conn.provider === "cloud_api" && template.metaName ? { name: template.metaName, language: template.metaLanguage ?? "en", params: variablesIn(template.body).map((v) => (v === "customer_first_name" ? (contactFirstName(contact) ?? "") : businessNameOf(store, settings))) } : null },
      templateId: template.id,
      idempotencyKey: `campaign:${c.id}:${contact.id}`,
      campaignId: c.id,
      sendAfter: new Date(t),
    });
    if (created) {
      made++;
      t += step;
    }
  }
  const lastId = contacts.at(-1)?.id ?? c.cursor;
  const finished = contacts.length < BATCH || c.recipients + made >= cap;
  await systemDb.wappCampaign.update({ where: { id: c.id }, data: { cursor: lastId, recipients: { increment: made }, ...(finished ? { materializedAt: new Date() } : {}) } });
  if (!finished) await waQueue(deps.queues).send({ kind: "wapp_campaign", campaignId: c.id }, { delaySeconds: 2 });
  logger.info({ campaignId: c.id, storeId: c.storeId, made, finished }, "whatsapp campaign batch made");
  return finished ? "materialized" : "batch";
}

/** A campaign's results, from its messages. */
export async function campaignReport(campaignId: string) {
  const rows = await systemDb.wappMessage.groupBy({ by: ["status"], where: { campaignId }, _count: { _all: true } });
  const by = Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<string, number>;
  const n = (...s: string[]) => s.reduce((sum, k) => sum + (by[k] ?? 0), 0);
  return { total: n(...Object.keys(by)), waiting: n("queued", "sending"), sent: n("accepted", "sent", "delivered", "read"), delivered: n("delivered", "read"), read: n("read"), failed: n("failed"), notSent: n("skipped", "cancelled") };
}

/**
 * The WhatsApp message queue. A message is a row first (whatsapp_messages, status "scheduled"),
 * so nothing is lost when a queue message is, and one row per purpose (dedupe_key) means Shopify
 * retries, duplicate webhooks and two rules firing together still send once. Queue messages only
 * say "look at row X now"; the sweeper (worker cron) finds anything due that has none.
 *
 * Everything that decides whether a customer should get a message is checked again right before
 * it goes out: they may have said STOP, finished their checkout or written a review since.
 */
import { Prisma, systemDb, type WhatsappContact, type WhatsappMessage } from "@app/db";
import {
  buildComponents,
  errorExplanation,
  inSendWindow,
  nextSendTime,
  randomToken,
  templateShape,
  WA_MAX_ATTEMPTS,
  WA_RETRY_DELAYS_S,
  type ParamSource,
  type TemplateComponent,
  type TemplateMapping,
  type WhatsappConfig,
} from "@app/shared";
import type { Coord } from "../coord.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { Producer, Queues } from "../queues.js";
import type { FetchLike } from "../shopify.js";
import { WhatsappError } from "./errors.js";
import { waSendTemplate, WhatsappApiError } from "./graph.js";
import { applyMarketing, connectionToken, contactWaId, markReconnect, parseConfig, tierLimit, waDecrypt, waEncrypt } from "./store.js";

export interface WhatsappSendJob {
  kind: "whatsapp";
  messageId: string;
}
export interface WhatsappDispatchJob {
  kind: "whatsapp_dispatch";
  storeId: string;
}
export type WhatsappJob = WhatsappSendJob | WhatsappDispatchJob;

/** WhatsApp jobs ride the sync queue (like ad syncs), told apart by `kind`: no new queue to provision. */
export const waQueue = (queues: Queues) => queues.sync as unknown as Producer<WhatsappJob>;

export interface WaDeps {
  coord: Coord;
  queues: Queues;
  fetchImpl: FetchLike;
}

/** The longest a queued send waits in the queue; sends due later are picked up by the sweeper. */
const MAX_QUEUE_DELAY_S = 12 * 3600;
/** Messages per second per number. Meta allows 80; staying well under leaves room for retries and other tools. */
export const WA_SENDS_PER_SECOND = 20;
/** A message that can't go out because WhatsApp isn't connected (or needs reconnecting) waits this long, then is cancelled. */
const CONNECTION_GRACE_MS = 48 * 3600_000;
/** A template still in Meta's review is waited for this long. */
const TEMPLATE_PENDING_GRACE_MS = 24 * 3600_000;

/** What a send needs that only the triggering event knew. Encrypted at rest; cleared once sent. */
interface SendParams {
  mapping: TemplateMapping;
  values: Partial<Record<ParamSource, string | null>>;
  media?: { link: string } | null;
  /** Test sends only: the merchant's own number, typed in for this one send. */
  testTo?: string;
}

export interface ScheduleInput {
  store: { id: string; workspaceId: string };
  kind: string;
  dedupeKey: string;
  contact: Pick<WhatsappContact, "id" | "phoneMasked"> | null;
  template: { name: string; language: string } | null;
  mapping: TemplateMapping;
  values: Partial<Record<ParamSource, string | null>>;
  media?: { link: string } | null;
  scheduledFor: Date;
  trackingId?: string | null;
  orderName?: string | null;
  checkoutId?: string | null;
  campaignId?: string | null;
  ruleId?: string | null;
  /** Where the message's tracked link (/api/r/<code>) leads. Fills checkout_/campaign_ link values. */
  clickUrl?: string | null;
  /** Record the message as skipped, with this reason, instead of scheduling it. */
  skip?: string | null;
  test?: { to: string } | null;
}

/** The row's data for a new message (shared by single sends and campaign batches). */
export function messageRow(input: ScheduleInput): Prisma.WhatsappMessageCreateManyInput {
  const values = { ...input.values };
  let clickCode: string | null = null;
  if (input.clickUrl) {
    clickCode = randomToken(9);
    const link = `${env().API_URL}/r/${clickCode}`;
    values.checkout_link_code ??= clickCode;
    values.campaign_link_code ??= clickCode;
    values.checkout_url ??= link;
    values.campaign_url ??= link;
  }
  const params: SendParams = { mapping: input.mapping, values, media: input.media ?? null, ...(input.test ? { testTo: input.test.to } : {}) };
  const skipped = !!input.skip;
  return {
    workspaceId: input.store.workspaceId,
    storeId: input.store.id,
    contactId: input.contact?.id ?? null,
    kind: input.kind,
    templateName: input.template?.name ?? null,
    templateLanguage: input.template?.language ?? null,
    paramsEnc: skipped ? null : waEncrypt(input.store.id, "params", JSON.stringify(params)),
    dedupeKey: input.dedupeKey,
    phoneMasked: input.contact?.phoneMasked ?? null,
    trackingId: input.trackingId ?? null,
    orderName: input.orderName ?? null,
    checkoutId: input.checkoutId ?? null,
    campaignId: input.campaignId ?? null,
    ruleId: input.ruleId ?? null,
    status: skipped ? "skipped" : "scheduled",
    reason: input.skip ?? null,
    scheduledFor: input.scheduledFor,
    clickCode,
    clickUrlEnc: input.clickUrl ? waEncrypt(input.store.id, "click", input.clickUrl) : null,
    test: !!input.test,
  };
}

/**
 * Create the message unless one with this purpose exists (then that one is returned untouched).
 * A message due within 12 hours is put on the queue right away, with the wait as its delay.
 */
export async function scheduleMessage(input: ScheduleInput, deps: Pick<WaDeps, "queues">): Promise<{ message: WhatsappMessage; created: boolean }> {
  let message: WhatsappMessage;
  try {
    message = await systemDb.whatsappMessage.create({ data: messageRow(input) as Prisma.WhatsappMessageUncheckedCreateInput });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const existing = await systemDb.whatsappMessage.findUnique({ where: { storeId_dedupeKey: { storeId: input.store.id, dedupeKey: input.dedupeKey } } });
    if (!existing) throw err;
    return { message: existing, created: false };
  }
  if (message.status === "scheduled") await enqueueSend(message, deps);
  return { message, created: true };
}

/** Put a scheduled message on the queue if it is due within the queue's delay limit. */
export async function enqueueSend(message: Pick<WhatsappMessage, "id" | "scheduledFor">, deps: Pick<WaDeps, "queues">) {
  const wait = Math.max(0, Math.ceil((message.scheduledFor.getTime() - Date.now()) / 1000));
  if (wait > MAX_QUEUE_DELAY_S) return;
  try {
    await waQueue(deps.queues).send({ kind: "whatsapp", messageId: message.id }, wait ? { delaySeconds: wait } : undefined);
    await systemDb.whatsappMessage.updateMany({ where: { id: message.id }, data: { enqueuedAt: new Date() } });
  } catch (err) {
    // The row is the source of truth: the sweeper sends it on its next pass.
    logger.warn({ err, messageId: message.id }, "could not queue a whatsapp message; the sweeper will pick it up");
  }
}

/**
 * Cancel what's still waiting: one message, or everything for an order, a checkout, a campaign or
 * a rule (purpose kinds optional). `storeId` / `workspaceId` narrow it further.
 */
export async function cancelScheduled(
  where: { id?: string; storeId?: string; workspaceId?: string; trackingId?: string; checkoutId?: string; campaignId?: string; ruleId?: string; kinds?: string[]; exceptKinds?: string[] },
  reason: string,
) {
  // Without one of these it would cancel every store's waiting messages.
  if (!where.id && !where.trackingId && !where.checkoutId && !where.campaignId && !where.ruleId) throw new Error("cancelScheduled needs a message, order, checkout, campaign or rule");
  const { count } = await systemDb.whatsappMessage.updateMany({
    where: {
      status: "scheduled",
      ...(where.id ? { id: where.id } : {}),
      ...(where.storeId ? { storeId: where.storeId } : {}),
      ...(where.workspaceId ? { workspaceId: where.workspaceId } : {}),
      ...(where.ruleId ? { ruleId: where.ruleId } : {}),
      ...(where.trackingId ? { trackingId: where.trackingId } : {}),
      ...(where.checkoutId ? { checkoutId: where.checkoutId } : {}),
      ...(where.campaignId ? { campaignId: where.campaignId } : {}),
      ...(where.kinds ? { kind: { in: where.kinds } } : {}),
      ...(where.exceptKinds ? { kind: { notIn: where.exceptKinds } } : {}),
    },
    data: { status: "cancelled", cancelledAt: new Date(), reason, paramsEnc: null },
  });
  return count;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type SendOutcome = "sent" | "skipped" | "cancelled" | "failed" | "rescheduled" | "not_due" | "gone";

const CART_KINDS = new Set(["abandoned_cart_1", "abandoned_cart_2"]);
const REVIEW_KINDS = new Set(["review_request", "review_reminder"]);
/** Order kinds that still make sense once the order is cancelled. */
const AFTER_CANCEL_OK = new Set(["order_cancelled", "refund_processed"]);

async function settle(id: string, data: Prisma.WhatsappMessageUpdateInput) {
  await systemDb.whatsappMessage.update({ where: { id }, data });
}

/** Back to waiting, without spending an attempt (the message itself is fine; the moment isn't). */
async function hold(msg: WhatsappMessage, until: Date, reason: string, deps: WaDeps): Promise<SendOutcome> {
  const updated = await systemDb.whatsappMessage.update({
    where: { id: msg.id },
    data: { status: "scheduled", scheduledFor: until, reason, attempts: { decrement: 1 }, enqueuedAt: null },
  });
  await enqueueSend(updated, deps);
  return "rescheduled";
}

/**
 * Send one message, if it is due and still wanted. Safe to call twice: only the call that moves
 * the row from "scheduled" to "sending" sends.
 */
export async function sendWhatsappMessage(messageId: string, deps: WaDeps): Promise<SendOutcome> {
  const msg = await systemDb.whatsappMessage.findUnique({ where: { id: messageId } });
  if (!msg || msg.status !== "scheduled") return "gone";
  if (msg.scheduledFor.getTime() > Date.now() + 5_000) {
    await enqueueSend(msg, deps);
    return "not_due";
  }
  const claimed = await systemDb.whatsappMessage.updateMany({ where: { id: msg.id, status: "scheduled" }, data: { status: "sending", attempts: { increment: 1 } } });
  if (!claimed.count) return "gone";
  const current = { ...msg, status: "sending", attempts: msg.attempts + 1 };
  try {
    return await deliver(current, deps);
  } catch (err) {
    // Our own failure (the database, a bug): back to the queue with the retry backoff, never stuck in "sending".
    logger.error({ err, messageId }, "whatsapp send failed unexpectedly");
    await retryOrFail(current, { code: null, title: "internal_error", details: err instanceof Error ? err.message : String(err) }, deps).catch((e: unknown) =>
      logger.error({ err: e, messageId }, "could not record a whatsapp send failure"),
    );
    return "rescheduled";
  }
}

async function retryOrFail(msg: WhatsappMessage, e: { code: number | null; title: string; details: string | null }, deps: WaDeps): Promise<SendOutcome> {
  if (msg.attempts >= WA_MAX_ATTEMPTS) {
    await settle(msg.id, { status: "failed", failedAt: new Date(), errorCode: e.code !== null ? String(e.code) : null, errorTitle: (e.details || e.title).slice(0, 300), reason: "retries_exhausted" });
    return "failed";
  }
  const wait = WA_RETRY_DELAYS_S[Math.min(msg.attempts - 1, WA_RETRY_DELAYS_S.length - 1)]!;
  const updated = await systemDb.whatsappMessage.update({
    where: { id: msg.id },
    data: {
      status: "scheduled",
      scheduledFor: new Date(Date.now() + wait * 1000),
      errorCode: e.code !== null ? String(e.code) : null,
      errorTitle: (e.details || e.title).slice(0, 300),
      reason: "retrying",
      enqueuedAt: null,
    },
  });
  await enqueueSend(updated, deps);
  return "rescheduled";
}

/** Whether a utility (order update) message may go to this contact, under the store's consent basis. */
function transactionalAllowed(cfg: WhatsappConfig, contact: WhatsappContact, order: { cartOptIn: boolean; smsConsent: boolean } | null): string | null {
  const optedInOnWhatsapp = contact.marketingStatus === "opted_in" && contact.marketingSource !== "shopify_sms";
  switch (cfg.transactionalBasis) {
    case "none":
      return "consent_basis_not_set";
    case "checkout_notice":
      return null;
    case "cart_attribute":
      return order?.cartOptIn || optedInOnWhatsapp ? null : "no_opt_in";
    case "sms_consent":
      return order?.smsConsent || contact.marketingStatus === "opted_in" ? null : "no_opt_in";
  }
}

export function marketingAllowed(cfg: WhatsappConfig, contact: Pick<WhatsappContact, "marketingStatus" | "marketingSource" | "optedOut">): boolean {
  if (contact.optedOut || contact.marketingStatus !== "opted_in") return false;
  return contact.marketingSource !== "shopify_sms" || cfg.smsConsentCountsForMarketing;
}

async function deliver(msg: WhatsappMessage, deps: WaDeps): Promise<SendOutcome> {
  const now = new Date();
  const [settings, conn, store] = await Promise.all([
    systemDb.whatsappSettings.findUnique({ where: { storeId: msg.storeId } }),
    systemDb.whatsappConnection.findUnique({ where: { storeId: msg.storeId } }),
    systemDb.store.findUnique({ where: { id: msg.storeId }, select: { id: true, status: true, timezone: true } }),
  ]);
  const cancel = async (reason: string): Promise<SendOutcome> => {
    await settle(msg.id, { status: "cancelled", cancelledAt: now, reason, paramsEnc: null });
    return "cancelled";
  };
  const skip = async (reason: string): Promise<SendOutcome> => {
    await settle(msg.id, { status: "skipped", reason, paramsEnc: null });
    return "skipped";
  };
  if (!settings || !store || store.status === "uninstalled") return cancel("whatsapp_off");
  const cfg = parseConfig(settings.config);

  if (!conn || conn.status === "reconnect" || conn.status === "error" || !conn.registered) {
    if (now.getTime() - msg.createdAt.getTime() > CONNECTION_GRACE_MS) return cancel("whatsapp_not_connected");
    return hold(msg, new Date(now.getTime() + 30 * 60_000), "waiting_for_connection", deps);
  }

  const params = msg.paramsEnc ? (JSON.parse(waDecrypt(msg.storeId, "params", msg.paramsEnc)) as SendParams) : null;
  if (!params) return skip("nothing_to_send");

  let contact: WhatsappContact | null = null;
  let to: string;
  if (msg.test) {
    if (!params.testTo) return skip("no_phone");
    to = params.testTo;
  } else {
    contact = msg.contactId ? await systemDb.whatsappContact.findUnique({ where: { id: msg.contactId } }) : null;
    if (!contact) return skip("no_phone");
    if (contact.optedOut) return cancel("opted_out");
    to = contactWaId(contact);
  }

  if (!msg.templateName || !msg.templateLanguage) return skip("no_template");
  const template = await systemDb.whatsappTemplate.findUnique({
    where: { connectionId_name_language: { connectionId: conn.id, name: msg.templateName, language: msg.templateLanguage } },
  });
  if (!template) return skip("template_missing");
  if (template.status !== "APPROVED") {
    if (template.status === "PENDING" && now.getTime() - msg.createdAt.getTime() < TEMPLATE_PENDING_GRACE_MS) {
      return hold(msg, new Date(now.getTime() + 30 * 60_000), "template_pending", deps);
    }
    return skip("template_not_approved");
  }
  const category = template.category.toLowerCase();
  const marketing = category === "marketing";

  // Still wanted? The world may have moved on since this was scheduled.
  const tracking = msg.trackingId ? await systemDb.orderTracking.findUnique({ where: { id: msg.trackingId } }) : null;
  if (msg.checkoutId) {
    const checkout = await systemDb.abandonedCheckout.findUnique({ where: { id: msg.checkoutId } });
    if (!checkout || checkout.completedAt || !["open", "reminded", "ineligible"].includes(checkout.status)) return cancel("checkout_completed");
    const ordered = await systemDb.orderTracking.findFirst({ where: { storeId: msg.storeId, checkoutToken: checkout.checkoutToken }, select: { id: true } });
    if (ordered) return cancel("checkout_completed");
    if (msg.kind === "abandoned_cart_2") {
      const first = await systemDb.whatsappMessage.findFirst({ where: { checkoutId: checkout.id, kind: "abandoned_cart_1", status: { in: ["sent", "delivered", "read"] } } });
      if (!first) return cancel("first_reminder_not_sent");
    }
  }
  if (REVIEW_KINDS.has(msg.kind) && tracking) {
    if (await systemDb.customerReview.findFirst({ where: { trackingId: tracking.id }, select: { id: true } })) return cancel("already_reviewed");
    if (tracking.cancelledAt) return cancel("order_cancelled");
    if (msg.kind === "review_reminder") {
      const request = await systemDb.whatsappMessage.findFirst({ where: { trackingId: tracking.id, kind: "review_request", status: { in: ["sent", "delivered", "read"] } } });
      if (!request) return cancel("request_not_sent");
    }
  }
  if (tracking && tracking.cancelledAt && !AFTER_CANCEL_OK.has(msg.kind) && !CART_KINDS.has(msg.kind) && msg.kind !== "test") return cancel("order_cancelled");
  if (msg.campaignId) {
    const campaign = await systemDb.whatsappCampaign.findUnique({ where: { id: msg.campaignId }, select: { status: true, endAt: true } });
    if (!campaign || campaign.status === "cancelled") return cancel("campaign_cancelled");
    if (campaign.endAt && campaign.endAt < now) return cancel("campaign_ended");
    if (campaign.status === "paused") return hold(msg, new Date(now.getTime() + 15 * 60_000), "campaign_paused", deps);
  }

  // Consent, at the moment of sending.
  if (contact) {
    if (marketing) {
      if (!marketingAllowed(cfg, contact)) return skip("no_marketing_consent");
    } else {
      const why = transactionalAllowed(cfg, contact, tracking);
      if (why) return skip(why);
    }
  }

  if (marketing && !msg.test) {
    if (!inSendWindow(now, store.timezone, cfg.sendWindowStart, cfg.sendWindowEnd)) {
      return hold(msg, nextSendTime(now, store.timezone, cfg.sendWindowStart, cfg.sendWindowEnd), "outside_send_window", deps);
    }
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const recent = await systemDb.whatsappMessage.count({
      where: { contactId: contact!.id, category: "marketing", status: { in: ["sent", "delivered", "read"] }, sentAt: { gte: weekAgo }, test: false },
    });
    if (recent >= cfg.marketingPerWeek) return skip("frequency_cap");
  }

  // The number's daily limit on customers it starts conversations with.
  if (contact && !msg.test) {
    const limit = tierLimit(conn.messagingLimitTier);
    if (Number.isFinite(limit)) {
      const since = new Date(now.getTime() - 86_400_000);
      const reached = await systemDb.whatsappMessage.groupBy({
        by: ["contactId"],
        where: { storeId: msg.storeId, sentAt: { gte: since }, test: false, contactId: { not: null } },
      });
      if (reached.length >= limit && !reached.some((r) => r.contactId === contact!.id)) {
        return hold(msg, new Date(now.getTime() + 3600_000), "messaging_limit", deps);
      }
    }
  }

  // Per-second pacing for the number.
  if ((await deps.coord.hit(`wa-mps:${conn.id}`, 1)) > WA_SENDS_PER_SECOND) {
    return hold(msg, new Date(now.getTime() + 2_000), msg.reason ?? "pacing", deps);
  }

  let components: Array<Record<string, unknown>>;
  try {
    components = buildComponents(templateShape(template.components as unknown as TemplateComponent[]), params.mapping, params.values, params.media).components;
  } catch (err) {
    return skip(`template_mismatch: ${(err as Error).message}`.slice(0, 200));
  }

  try {
    const wamid = await waSendTemplate(conn.phoneNumberId, connectionToken(conn), to, { name: template.name, language: template.language, components }, deps.fetchImpl);
    await settle(msg.id, { status: "sent", providerMessageId: wamid, sentAt: new Date(), category, paramsEnc: null, errorCode: null, errorTitle: null, reason: null });
    if (msg.checkoutId) await systemDb.abandonedCheckout.updateMany({ where: { id: msg.checkoutId, status: "open" }, data: { status: "reminded" } });
    return "sent";
  } catch (err) {
    if (!(err instanceof WhatsappApiError)) throw err;
    logger.warn({ messageId: msg.id, code: err.code, status: err.httpStatus, action: err.action }, "whatsapp send refused");
    switch (err.action) {
      case "reconnect":
        await markReconnect(conn.id, err.message);
        return hold(msg, new Date(now.getTime() + 30 * 60_000), "waiting_for_connection", deps);
      case "marketing_opt_out":
        if (contact) await applyMarketing(contact, { status: "opted_out", source: "meta_preferences" });
        return skip("marketing_stopped");
      case "retry":
        return retryOrFail(msg, { code: err.code, title: err.title, details: err.details }, deps);
      default:
        await settle(msg.id, {
          status: "failed",
          failedAt: new Date(),
          category,
          errorCode: err.code !== null ? String(err.code) : String(err.httpStatus),
          errorTitle: errorExplanation(err.code, err.details ?? err.title).slice(0, 300),
          paramsEnc: null,
        });
        return "failed";
    }
  }
}

/** The message is in a state a retry can't start from (the reason is safe to show the merchant). */
export class NotRetryableError extends WhatsappError {
  constructor(message: string) {
    super(message, 409, "not_retryable");
    this.name = "NotRetryableError";
  }
}

const RETRYABLE = ["failed", "skipped", "cancelled"];

/** Whether the merchant can send this message again by hand (what requeueMessage accepts). */
export const canRequeue = (msg: Pick<WhatsappMessage, "status" | "paramsEnc">) => !!msg.paramsEnc && RETRYABLE.includes(msg.status);

/** Retry a failed or skipped message by hand (the merchant fixed the template, the customer opted in). */
export async function requeueMessage(msg: WhatsappMessage, deps: WaDeps) {
  if (!RETRYABLE.includes(msg.status)) throw new NotRetryableError("Only failed, skipped or cancelled messages can be retried");
  if (!msg.paramsEnc) throw new NotRetryableError("This message's details have been cleared; it can't be sent again");
  const updated = await systemDb.whatsappMessage.update({
    where: { id: msg.id },
    data: { status: "scheduled", scheduledFor: new Date(), attempts: 0, reason: null, errorCode: null, errorTitle: null, failedAt: null, cancelledAt: null, enqueuedAt: null },
  });
  await enqueueSend(updated, deps);
  return updated;
}

/** Messages per dispatch invocation; the chain re-sends itself while more are due. */
const DISPATCH_BATCH = 25;

/** Send every due message of one store (campaign batches, anything the queue lost). */
export async function dispatchStore(storeId: string, deps: WaDeps): Promise<{ processed: number; more: boolean }> {
  const due = await systemDb.whatsappMessage.findMany({
    where: { storeId, status: "scheduled", scheduledFor: { lte: new Date() } },
    orderBy: { scheduledFor: "asc" },
    take: DISPATCH_BATCH,
    select: { id: true },
  });
  for (const m of due) await sendWhatsappMessage(m.id, deps);
  const more = due.length === DISPATCH_BATCH;
  if (more) await waQueue(deps.queues).send({ kind: "whatsapp_dispatch", storeId }, { delaySeconds: 1 });
  else await deps.coord.release(`wa-dispatch:${storeId}`).catch(() => {});
  return { processed: due.length, more };
}

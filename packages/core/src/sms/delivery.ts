/**
 * AWS's delivery events → each message's status and cost.
 *
 * The App stack's configuration set sends every SMS event to an SNS topic only AWS End User
 * Messaging may publish to, and the topic delivers them (raw) to the sms-events queue the jobs
 * function reads: nobody outside the account can post one. Events arrive late (up to 72 hours),
 * twice and out of order, so:
 *  - each is stored once (provider message id, event type, time): a replay changes nothing;
 *  - a status only moves forward (statusMayMove): a final one is replaced only by a later final one;
 *  - an event names its message by the job id we put in the send's Context, so it is matched even
 *    when it arrives before the send recorded AWS's message id, and it settles an "uncertain" send
 *    (one whose answer never came back) with what really happened;
 *  - the price is what AWS reports with the event (US dollars), recorded once per message.
 */
import { z } from "zod";
import { Prisma, systemDb } from "@app/db";
import { billingMonth, budgetLevelsReached, isFinalStatus, statusFromEvent, statusMayMove, type SmsStatus } from "@app/shared/sms";
import { logger } from "../logger.js";
import { raiseAlert, resolveAlerts } from "../notify.js";
import { monthSpend, type SmsDeps } from "./common.js";
import { contactPhone, suppressNumber } from "./contacts.js";

const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);

/** One SMS event as AWS writes it (configuration-sets-event-format). Unknown fields pass. */
export const smsEventSchema = z
  .object({
    eventType: z.string(),
    eventVersion: z.string().optional(),
    eventTimestamp: num,
    isFinal: z.boolean().optional().default(false),
    destinationPhoneNumber: z.string().optional(),
    isoCountryCode: z.string().optional(),
    messageId: z.string().min(1),
    messageRequestTimestamp: num.optional(),
    messageEncoding: z.string().optional(),
    messageType: z.string().optional(),
    messageStatus: z.string(),
    messageStatusDescription: z.string().optional(),
    context: z.record(z.string(), z.string()).optional(),
    totalMessageParts: num.optional(),
    totalMessagePrice: num.optional(),
    totalCarrierFee: num.optional(),
  })
  .passthrough();
export type SmsEvent = z.infer<typeof smsEventSchema>;

/** The queue body: the event itself (raw delivery), or SNS's envelope around it. */
function unwrap(body: unknown): unknown {
  const b = body as { Type?: string; Message?: unknown } | null;
  if (b && b.Type === "Notification" && typeof b.Message === "string") {
    try {
      return JSON.parse(b.Message);
    } catch {
      return null;
    }
  }
  return body;
}

/**
 * AWS documents totalMessagePrice as US dollars in its examples (0.00645) and, in one sentence,
 * as thousandths of a cent (645). A value no single message could cost in dollars is read the
 * second way.
 */
export const priceUsd = (v: number | undefined) => (v === undefined || !Number.isFinite(v) || v < 0 ? null : v > 10 ? v / 100_000 : v);

export class SmsEventNotYetKnown extends Error {
  override name = "SmsEventNotYetKnown";
}

export type EventResult = "applied" | "duplicate" | "ignored" | "unknown_message";

/** How long an event may wait for its message to be recorded (the send's own commit). */
const RACE_MS = 15 * 60_000;

/** Apply one event from the sms-events queue. Throws SmsEventNotYetKnown when it should come back later. */
export async function applySmsEvent(body: unknown, deps: Pick<SmsDeps, "mailer" | "fetchImpl">): Promise<EventResult> {
  const parsed = smsEventSchema.safeParse(unwrap(body));
  if (!parsed.success) {
    // Field paths only: the event carries the customer's number.
    logger.warn({ issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join(".")) }, "sms event doesn't fit; dropped");
    return "ignored";
  }
  const e = parsed.data;
  if (!e.eventType.startsWith("TEXT_")) return "ignored";
  const jobId = e.context?.job;
  let job = jobId ? await systemDb.smsMessageJob.findUnique({ where: { id: jobId } }) : null;
  if (job && e.context?.ws && job.workspaceId !== e.context.ws) job = null;
  job ??= await systemDb.smsMessageJob.findUnique({ where: { providerMessageId: e.messageId } });
  if (!job) {
    const requested = e.messageRequestTimestamp ?? e.eventTimestamp;
    if (jobId && Date.now() - requested < RACE_MS) throw new SmsEventNotYetKnown("sms event before its message was recorded");
    logger.info({ eventType: e.eventType, hasContext: !!jobId }, "sms event for no message of ours; dropped");
    return "unknown_message";
  }
  if (job.providerMessageId && job.providerMessageId !== e.messageId) {
    logger.warn({ jobId: job.id }, "sms event's message id differs from the one recorded; dropped");
    return "ignored";
  }

  const eventAt = new Date(e.eventTimestamp);
  const price = priceUsd(e.totalMessagePrice);
  const fee = priceUsd(e.totalCarrierFee);
  const parts = e.totalMessageParts !== undefined ? Math.max(0, Math.round(e.totalMessageParts)) : null;
  try {
    await systemDb.smsDeliveryEvent.create({
      data: {
        workspaceId: job.workspaceId,
        storeId: job.storeId,
        jobId: job.id,
        providerMessageId: e.messageId,
        eventType: e.eventType,
        messageStatus: e.messageStatus,
        isFinal: e.isFinal,
        eventAt,
        isoCountry: e.isoCountryCode ?? null,
        parts,
        priceUsd: price,
        carrierFeeUsd: fee,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "duplicate";
    throw err;
  }

  const next = statusFromEvent(e.messageStatus, e.isFinal);
  const current = job.status as SmsStatus;
  const move = current === "sending" || statusMayMove(current, next, job.providerStatusAt?.getTime() ?? null, eventAt.getTime());
  const now = new Date();
  await systemDb.smsMessageJob.update({
    where: { id: job.id },
    data: {
      providerMessageId: job.providerMessageId ?? e.messageId,
      acceptedAt: job.acceptedAt ?? new Date(e.messageRequestTimestamp ?? e.eventTimestamp),
      ...(move ? { status: next, providerStatus: e.messageStatus, providerStatusAt: eventAt, ...(isFinalStatus(next) ? { finalAt: now, valuesEnc: null } : {}), ...(next === "failed" ? { errorCode: e.messageStatus.toLowerCase() } : {}) } : {}),
      ...(price !== null ? { priceUsd: price, carrierFeeUsd: fee ?? 0, ...(parts !== null ? { partsBilled: parts } : {}) } : {}),
    },
  });

  if (price !== null) await recordCost(job, price, fee ?? 0, parts ?? job.segments ?? 0, e.isoCountryCode ?? job.destinationCountry, deps);

  // A number the carrier says doesn't exist won't start existing: kept off the list until the merchant lifts it.
  if (move && next === "failed" && e.messageStatus.toUpperCase() === "INVALID" && job.contactId) {
    const contact = await systemDb.smsContact.findUnique({ where: { id: job.contactId } });
    const store = contact ? await systemDb.store.findUnique({ where: { id: job.storeId }, select: { id: true, workspaceId: true } }) : null;
    if (contact && store) {
      await suppressNumber(store, contactPhone(contact), "all", "invalid_number", { evidence: { jobId: job.id, eventType: e.eventType } });
    }
  }
  return "applied";
}

/** One cost row per message (AWS repeats the price on later events), then the store's budget alerts. */
async function recordCost(job: { id: string; workspaceId: string; storeId: string; campaignId: string | null; ruleId: string | null; acceptedAt: Date | null }, price: number, fee: number, parts: number, country: string | null, deps: Pick<SmsDeps, "mailer" | "fetchImpl">) {
  const month = billingMonth(job.acceptedAt ?? new Date());
  await systemDb.smsCostRecord.upsert({
    where: { jobId: job.id },
    create: { workspaceId: job.workspaceId, storeId: job.storeId, jobId: job.id, campaignId: job.campaignId, ruleId: job.ruleId, country, month, parts, priceUsd: price, carrierFeeUsd: fee, totalUsd: price + fee },
    update: { country, parts, priceUsd: price, carrierFeeUsd: fee, totalUsd: price + fee },
  });
  await checkBudget(job.storeId, deps);
}

/** Raise the 50/80/100% budget alerts the store's spend has reached this month, once each. */
export async function checkBudget(storeId: string, deps: Pick<SmsDeps, "mailer" | "fetchImpl">): Promise<number[]> {
  const sender = await systemDb.smsSenderConfiguration.findUnique({ where: { storeId } });
  if (!sender) return [];
  const month = billingMonth(new Date());
  const stored = (sender.budgetAlerts ?? {}) as { month?: string; levels?: number[] };
  const announced = stored.month === month ? (stored.levels ?? []) : [];
  if (stored.month && stored.month !== month) await resolveAlerts(storeId, ["sms_budget_50", "sms_budget_80", "sms_budget_100"]);
  const spend = await monthSpend(storeId);
  const reached = budgetLevelsReached(spend.billedUsd, Number(sender.monthlyBudgetUsd), announced);
  if (!reached.length && stored.month === month) return [];
  await systemDb.smsSenderConfiguration.update({ where: { id: sender.id }, data: { budgetAlerts: { month, levels: [...announced, ...reached] } } });
  for (const level of reached) {
    await raiseAlert({ workspaceId: sender.workspaceId, storeId, severity: level === 100 ? "critical" : "warning", code: `sms_budget_${level}`, message: `SMS spend reached ${level}% of the monthly budget` }, deps.mailer, deps.fetchImpl).catch((err: unknown) => logger.error({ err }, "sms budget alert failed"));
  }
  return reached;
}

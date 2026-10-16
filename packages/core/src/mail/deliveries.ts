import { systemDb, type EmailDelivery } from "@app/db";
import { logger } from "../logger.js";
import type { Mailer, MailOptions } from "../notify.js";
import type { ProviderEvent } from "./resend.js";
import { classifyMailError, MailError, type DeliveryStatus } from "./types.js";

/**
 * Delivery records (email_deliveries): one per message we hand to the mail provider, updated by the
 * provider's own events. What the team page shows as an invitation's email status comes from here,
 * so "Sent" is only ever what the provider said, and "Delivered" only what its webhook reported.
 */

/** Attempts made while the inviter waits, before the rest is left to the email queue. */
const INLINE_ATTEMPTS = 2;
const INLINE_BACKOFF_MS = 600;
/** Attempts in all (inline ones included) before a transient failure is given up as "failed". */
export const MAX_DELIVERY_ATTEMPTS = 5;
/** The email queue's wait before the next attempt, after `attempts` so far: 1, 5, then 15 minutes (SQS allows up to 15). */
export const deliveryRetryDelaySec = (attempts: number) => [60, 300, 900][Math.min(2, Math.max(0, attempts - INLINE_ATTEMPTS))]!;

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  opts?: MailOptions;
}

export type DeliveryOutcome = { attempts: number } & (
  | { status: "sent"; provider: string; messageId: string | null }
  /** Transient failure: the delivery is left "queued" for the email queue to try again. */
  | { status: "queued"; error: MailError }
  | { status: "failed" | "not_allowed"; error: MailError }
);

/** A new delivery record, before the first attempt, so every attempt carries the same idempotency key. */
export function startDelivery(input: { workspaceId: string; invitationId?: string | null; kind: string }): Promise<EmailDelivery> {
  return systemDb.emailDelivery.create({ data: { workspaceId: input.workspaceId, invitationId: input.invitationId ?? null, kind: input.kind, provider: "pending", status: "queued" } });
}

/** The idempotency key for every attempt at one delivery. */
export const deliveryKey = (deliveryId: string) => `delivery-${deliveryId}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send one message for a delivery record and record the outcome. `inline`: attempts made now
 * (transient failures are retried after a short pause); a transient failure that outlasts them
 * leaves the record "queued" until MAX_DELIVERY_ATTEMPTS, then "failed". Never throws for a mail
 * failure: the outcome says what happened.
 */
export async function attemptDelivery(mailer: Mailer, delivery: Pick<EmailDelivery, "id" | "attempts">, msg: OutgoingMail, inline = INLINE_ATTEMPTS): Promise<DeliveryOutcome> {
  let attempts = delivery.attempts;
  let error: MailError | null = null;
  for (let i = 0; i < inline && attempts < MAX_DELIVERY_ATTEMPTS; i++) {
    if (i > 0) await sleep(INLINE_BACKOFF_MS * 2 ** (i - 1));
    attempts++;
    try {
      const receipt = await mailer.send(msg.to, msg.subject, msg.text, msg.html, { ...msg.opts, idempotencyKey: deliveryKey(delivery.id) });
      const provider = receipt?.provider ?? "unknown";
      const messageId = receipt?.messageId ?? null;
      await systemDb.emailDelivery
        .update({ where: { id: delivery.id }, data: { status: "sent", provider, providerMessageId: messageId, attempts, sentAt: new Date(), errorCode: null, errorMessage: null } })
        .catch((err: unknown) => logger.warn({ err, deliveryId: delivery.id }, "could not record a sent email"));
      return { status: "sent", provider, messageId, attempts };
    } catch (err) {
      error = classifyMailError(err);
      if (error.failure !== "transient") break;
    }
  }
  const e = error ?? new MailError("No attempt was made", "unknown", "transient", "not_attempted");
  const status: DeliveryStatus = e.failure === "not_allowed" ? "not_allowed" : e.failure === "permanent" || attempts >= MAX_DELIVERY_ATTEMPTS ? "failed" : "queued";
  await systemDb.emailDelivery
    .update({ where: { id: delivery.id }, data: { status, provider: e.provider, attempts, errorCode: e.code, errorMessage: e.message } })
    .catch((err: unknown) => logger.warn({ err, deliveryId: delivery.id }, "could not record a failed email"));
  logger.warn({ deliveryId: delivery.id, provider: e.provider, failure: e.failure, code: e.code, attempts, status }, "email not sent");
  return { status, error: e, attempts } as DeliveryOutcome;
}

/** How far along a message is: a provider event never moves it back (a late "sent" after "delivered"). */
const RANK: Record<DeliveryStatus, number> = { queued: 0, sent: 1, delayed: 2, delivered: 3, failed: 4, not_allowed: 4, bounced: 5, complained: 6 };

/**
 * Record a provider's delivery event (POST /webhooks/email/...). Events can arrive late and out of
 * order, and more than once: one that says less than what is on record changes nothing. Returns
 * whether a delivery of ours matched.
 */
export async function applyProviderEvent(event: ProviderEvent): Promise<boolean> {
  const d = await systemDb.emailDelivery.findUnique({ where: { provider_providerMessageId: { provider: event.provider, providerMessageId: event.messageId } } });
  if (!d) return false;
  const current = d.status as DeliveryStatus;
  if ((RANK[event.status] ?? 0) < (RANK[current] ?? 0)) return true;
  await systemDb.emailDelivery.update({
    where: { id: d.id },
    data: {
      status: event.status,
      lastEventAt: event.at,
      ...(event.status === "delivered" ? { deliveredAt: event.at } : {}),
      ...(event.errorCode || event.errorMessage ? { errorCode: event.errorCode, errorMessage: event.errorMessage } : {}),
    },
  });
  return true;
}

/** The latest delivery of each invitation, for the team list. */
export async function latestDeliveries(invitationIds: string[]): Promise<Map<string, EmailDelivery>> {
  if (!invitationIds.length) return new Map();
  const rows = await systemDb.emailDelivery.findMany({ where: { invitationId: { in: invitationIds } }, orderBy: { createdAt: "desc" } });
  const out = new Map<string, EmailDelivery>();
  for (const r of rows) if (r.invitationId && !out.has(r.invitationId)) out.set(r.invitationId, r);
  return out;
}

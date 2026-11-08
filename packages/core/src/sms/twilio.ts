/**
 * Twilio's side of Customer Messaging (docs/sms.md, "Twilio"): what the API's webhooks, the sweep
 * and the adapter (apps/aws/src/twilioSmsProvider.ts) share.
 *  - Its webhooks' signature: X-Twilio-Signature is base64(HMAC-SHA1(Auth Token, the URL Twilio
 *    called with its query, then each form field's name and value, sorted by name)).
 *  - A status report → the event core/sms/delivery.ts applies, in the "TEXT_*" shape AWS writes:
 *    one handler and one queue (smsEvents) for both providers. The job and workspace ride in the
 *    status URL's query, which the signature covers, as AWS carries them in the send's Context.
 *  - Its error codes → the refusal words classifySendError reads (an exception name and a Reason).
 *  - A STOP reply → the suppression list of every store texting from that number or service.
 *    Twilio blocks the number itself as well (its default opt-out handling), and refuses later
 *    sends to it with 21610, which reads as opted out too.
 *
 * Its price isn't in the status reports: the 15-minute sweep asks for it (messageCost).
 */
import { createHmac } from "node:crypto";
import { systemDb } from "@app/db";
import { normalizePhone, safeEqual } from "@app/shared";
import { isSmsStopKeyword } from "@app/shared/sms";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { suppressNumber } from "./contacts.js";

/** The API's routes (apps/api/src/routes/smsTwilio.ts), under /webhooks: outside the CSRF check and the per-IP limit. */
export const TWILIO_STATUS_PATH = "/webhooks/sms/twilio/status";
export const TWILIO_INBOUND_PATH = "/webhooks/sms/twilio/inbound";

const apiBase = (apiUrl: string) => apiUrl.replace(/\/+$/, "");

/** Where Twilio reports a text's status: the API's address with the send's context (job, ws) in the query, in a fixed order. */
export function twilioStatusUrl(context: Record<string, string>, apiUrl = env().API_URL): string {
  const q = new URLSearchParams(Object.entries(context).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toString();
  return `${apiBase(apiUrl)}${TWILIO_STATUS_PATH}${q ? `?${q}` : ""}`;
}

/** Where a number's or service's incoming texts go (set in Twilio's console, docs/sms.md). */
export const twilioInboundUrl = (apiUrl = env().API_URL) => `${apiBase(apiUrl)}${TWILIO_INBOUND_PATH}`;

/** X-Twilio-Signature for a form POST to `url` (the URL exactly as Twilio called it, query included). */
export function twilioSignature(authToken: string, url: string, form: URLSearchParams): string {
  let data = url;
  for (const key of [...new Set(form.keys())].sort()) for (const value of form.getAll(key).sort()) data += key + value;
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function validTwilioSignature(authToken: string, url: string, form: URLSearchParams, header: string | null | undefined): boolean {
  if (!authToken || !header) return false;
  return safeEqual(twilioSignature(authToken, url, form), header);
}

/** The country of one of the platform's numbers ("+61…" → "AU"), for the adapter (apps/aws has no @app/shared). */
export const twilioNumberCountry = (e164: string): string | null => normalizePhone(e164, null)?.country ?? null;

/** Equal strings, in time that doesn't depend on where they differ (the adapter's code check). */
export const twilioSafeEqual = (a: string, b: string): boolean => safeEqual(a, b);

/**
 * The bizinsights tags in a Twilio friendly name: Twilio's numbers and services have no tags, so
 * the platform owner writes "bizinsights:workspace=<id>" (or "bizinsights:shared=true") into the
 * friendly name, as the AWS identities carry those as tags (core/sms/senders.ts identityAllowed).
 */
export function twilioTags(friendlyName: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (friendlyName ?? "").matchAll(/(?:^|[\s;,|])(bizinsights:[a-z_]+)=([A-Za-z0-9_-]+)/g)) out[m[1]!] = m[2]!;
  return out;
}

// ---------------------------------------------------------------------------
// Refusals and statuses, in the send path's words
// ---------------------------------------------------------------------------

/** Twilio's error codes on a send → [AWS's exception name, a Reason classifySendError reads]. */
const SEND_ERRORS: Record<number, [string, string]> = {
  // "Attempt to send to unsubscribed recipient": the number replied STOP to this sender.
  21610: ["ConflictException", "DESTINATION_PHONE_NUMBER_OPTED_OUT"],
  // A trial account (or one without an approved compliance profile) reaches verified numbers only.
  21608: ["ConflictException", "DESTINATION_PHONE_NUMBER_NOT_VERIFIED"],
  // The destination's country isn't switched on in the account's Geo Permissions.
  21408: ["ValidationException", "DESTINATION_COUNTRY_BLOCKED"],
  21211: ["ValidationException", "INVALID_PHONE_NUMBER"],
  // "'To' number is not a valid mobile number" (a landline): it won't start taking texts.
  21614: ["ValidationException", "INVALID_PHONE_NUMBER"],
  // This sender can't reach this number (a name where the country shows none, no route).
  21612: ["ValidationException", "INVALID_IDENTITY_FOR_DESTINATION_COUNTRY"],
  // The sender isn't one of the account's: hold it, as a deleted AWS identity is held.
  21212: ["ResourceNotFoundException", "ORIGINATION_IDENTITY_INVALID"],
  21606: ["ResourceNotFoundException", "ORIGINATION_IDENTITY_NOT_SMS_CAPABLE"],
  21659: ["ResourceNotFoundException", "ORIGINATION_IDENTITY_NOT_IN_ACCOUNT"],
  21660: ["ResourceNotFoundException", "ORIGINATION_IDENTITY_NOT_IN_ACCOUNT"],
  21701: ["ResourceNotFoundException", "MESSAGING_SERVICE_NOT_FOUND"],
  21703: ["ResourceNotFoundException", "MESSAGING_SERVICE_HAS_NO_SENDERS"],
  21704: ["ResourceNotFoundException", "MESSAGING_SERVICE_HAS_NO_SENDERS"],
  // US 10DLC campaign / toll-free verification not done.
  30034: ["ValidationException", "REGISTRATION_NOT_COMPLETE"],
  30032: ["ValidationException", "REGISTRATION_NOT_COMPLETE"],
  21617: ["ValidationException", "MESSAGE_TOO_LONG"],
  20003: ["AccessDeniedException", "AUTHENTICATION_FAILED"],
};

/**
 * A refused Twilio call in AWS's words, so classifySendError treats both providers alike. The
 * Reason keeps Twilio's code ("… TWILIO_21610") for the logs and the message's error code.
 */
export function twilioRefusal(httpStatus: number, code: number | null): { type: string; reason: string | null } {
  const tag = code ? `TWILIO_${code}` : null;
  if (httpStatus === 429 || code === 20429 || code === 14107) return { type: "ThrottlingException", reason: tag };
  if (httpStatus >= 500) return { type: "InternalServerException", reason: tag };
  const known = code ? SEND_ERRORS[code] : undefined;
  if (known) return { type: known[0], reason: `${known[1]} ${tag}` };
  if (httpStatus === 401 || httpStatus === 403) return { type: "AccessDeniedException", reason: tag };
  if (httpStatus === 404) return { type: "ResourceNotFoundException", reason: tag };
  return { type: "ValidationException", reason: tag ?? `HTTP_${httpStatus}` };
}

/** Error codes on an undelivered or failed text → AWS's final messageStatus words (statusFromEvent, smsStage). */
const FAILURES: Record<string, string> = {
  // The handset is off or out of coverage.
  "30003": "UNREACHABLE",
  // The number doesn't exist: delivery.ts keeps it off the list until the merchant lifts it.
  "30005": "INVALID",
  // A landline, or a carrier that can't take it: failed, not suppressed.
  "30006": "UNROUTABLE",
  "30004": "BLOCKED",
  "30007": "SPAM",
  "30034": "CARRIER_BLOCKED",
  "30032": "CARRIER_BLOCKED",
  "21610": "BLOCKED",
};

/** A Twilio status → the delivery event's messageStatus and whether it is final; null for statuses that say nothing about delivery. */
export function twilioDeliveryStatus(status: string, errorCode: string | null | undefined): { messageStatus: string; isFinal: boolean } | null {
  const s = status.toLowerCase();
  if (s === "delivered" || s === "read") return { messageStatus: "DELIVERED", isFinal: true };
  // "sent": the carrier has it. Where carriers send no receipt Twilio says nothing more, and the
  // sweep calls it unknown after 74 hours, as for AWS.
  if (s === "queued" || s === "accepted" || s === "sending" || s === "sent") return { messageStatus: "PENDING", isFinal: false };
  if (s === "undelivered" || s === "failed") return { messageStatus: FAILURES[(errorCode ?? "").trim()] ?? "FAILED", isFinal: true };
  return null;
}

/** The fields of a status report this needs (Twilio sends more; all of them are signed). */
export function twilioStatusEvent(form: URLSearchParams, query: URLSearchParams, now = Date.now()): Record<string, unknown> | null {
  const messageId = form.get("MessageSid") ?? form.get("SmsSid");
  const status = form.get("MessageStatus") ?? form.get("SmsStatus");
  if (!messageId || !status) return null;
  const errorCode = form.get("ErrorCode");
  const mapped = twilioDeliveryStatus(status, errorCode);
  if (!mapped) return null;
  const context: Record<string, string> = {};
  for (const key of ["job", "ws"]) {
    const v = query.get(key);
    if (v) context[key] = v;
  }
  return {
    eventType: `TEXT_${status.toUpperCase()}`,
    eventVersion: "twilio",
    // Twilio's report carries no time: the time it arrived (a retried report is another row, and moves nothing).
    eventTimestamp: now,
    isFinal: mapped.isFinal,
    messageId,
    messageStatus: mapped.messageStatus,
    messageStatusDescription: `Twilio ${status.toLowerCase()}${errorCode ? ` ${errorCode}` : ""}`,
    ...(Object.keys(context).length ? { context } : {}),
  };
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/**
 * A text a customer sent to one of the platform's numbers. Only STOP is read (no two-way flow):
 * Twilio's Advanced Opt-Out says so in OptOutType; without it, the standard keywords. The number
 * goes on the suppression list of every store whose sender is that number or service, at once.
 * START is left to Twilio (it unblocks the number there): the opt-out here stays, like every
 * opt-out a customer makes themselves, which the merchant can't lift either (docs/sms.md,
 * "Consent and opt-outs").
 */
export async function applyTwilioInbound(form: URLSearchParams): Promise<{ stop: boolean; stores: number; added: number }> {
  const optOutType = (form.get("OptOutType") ?? "").toUpperCase();
  const stop = optOutType ? optOutType === "STOP" : isSmsStopKeyword(form.get("Body"));
  if (!stop) return { stop: false, stores: 0, added: 0 };
  const from = normalizePhone(form.get("From"), null);
  if (!from) {
    logger.warn({ messageSid: form.get("MessageSid") }, "twilio STOP reply without a usable number; dropped");
    return { stop: true, stores: 0, added: 0 };
  }
  const to = (form.get("To") ?? "").trim();
  const service = (form.get("MessagingServiceSid") ?? "").trim();
  const match = [
    ...(to ? [{ originationIdentity: to }, { identityLabel: to }] : []),
    ...(service ? [{ originationIdentity: service }, { originationIdentity: { startsWith: `${service}/` } }] : []),
  ];
  if (!match.length) return { stop: true, stores: 0, added: 0 };
  const senders = await systemDb.smsSenderConfiguration.findMany({ where: { OR: match }, select: { storeId: true, workspaceId: true } });
  let added = 0;
  for (const s of senders) {
    const r = await suppressNumber({ id: s.storeId, workspaceId: s.workspaceId }, from.e164, "all", "keyword_stop", { evidence: { provider: "twilio", messageSid: form.get("MessageSid"), optOutType: optOutType || null } });
    if (r.created) added++;
  }
  logger.info({ messageSid: form.get("MessageSid"), stores: senders.length, added }, "twilio STOP reply applied");
  return { stop: true, stores: senders.length, added };
}

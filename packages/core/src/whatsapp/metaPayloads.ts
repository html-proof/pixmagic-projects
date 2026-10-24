/**
 * What Meta's WhatsApp webhooks send us, as Zod schemas (applied in webhook.ts). The same boundary
 * as shopifyPayloads.ts: checked once, where it enters, after the signature; what doesn't fit is
 * logged by field path (never by value: a body carries phone numbers and messages) and skipped,
 * since Meta would redeliver the same body.
 *
 * The body is checked in layers, so one bad part costs only itself: the envelope, then each entry
 * (one WhatsApp Business Account), each change, and each status, message or preference inside it.
 * Only what an item can't be applied without is required; objects let unknown keys through, as
 * Meta adds fields over time.
 */
import { z } from "zod";
import { parsePayload, parsePayloadList } from "../payloads.js";

const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

/** Ids Meta sends as strings, and some (template ids) as numbers too. */
const id = z.union([z.string().min(1), z.number()]);
/** Unix seconds: a string in most payloads, a number in some. */
const unixTime = z.union([z.string(), z.number()]).nullish();
const str = z.string().nullish();
/** The number a change is for (`metadata.phone_number_id`). */
const metadata = obj({ phone_number_id: id.nullish() }).nullish();

/** The body. Anything but a WhatsApp Business Account body is not for us, and ignored. */
export const metaWebhookSchema = obj({ object: str, entry: z.array(z.unknown()).nullish() });

/** One account's part of the body. */
export const metaEntrySchema = obj({ id, changes: z.array(z.unknown()).nullish() });

/** One change; `value` is read by the schema for its field. */
export const metaChangeSchema = obj({ field: z.string(), value: z.unknown().optional() });

/** field "messages": delivery statuses and customers' own messages, for one number. */
export const metaMessagesValueSchema = obj({ metadata, statuses: z.array(z.unknown()).nullish(), messages: z.array(z.unknown()).nullish() });

/** A delivery status for a message we sent. */
export const metaStatusSchema = obj({
  id: z.string().min(1),
  status: z.string().min(1),
  timestamp: unixTime,
  errors: z.array(obj({ code: z.union([z.number(), z.string()]).nullish(), title: str, message: str, error_data: obj({ details: str }).nullish() })).nullish(),
  pricing: obj({ billable: z.boolean().nullish(), category: str }).nullish(),
});

/** A customer's message to the store: only its text matters (STOP / START). */
export const metaInboundSchema = obj({
  from: z.string().min(1),
  timestamp: unixTime,
  text: obj({ body: str }).nullish(),
  button: obj({ text: str }).nullish(),
  interactive: obj({ button_reply: obj({ title: str }).nullish() }).nullish(),
});

/** field "user_preferences": changes to the customer's marketing setting in WhatsApp. */
export const metaPreferencesValueSchema = obj({ metadata, user_preferences: z.array(z.unknown()).nullish() });

export const metaPreferenceSchema = obj({ wa_id: z.string().min(1), category: str, value: str, timestamp: unixTime });

/** message_template_status_update, template_category_update, message_template_quality_update. */
export const metaTemplateValueSchema = obj({
  event: str,
  message_template_id: id.nullish(),
  message_template_name: str,
  message_template_language: str,
  reason: str,
  new_category: str,
  new_quality_score: str,
});

/** phone_number_quality_update and account_update. */
export const metaAccountValueSchema = obj({ display_phone_number: str, current_limit: str, event: str });

export type MetaStatus = z.output<typeof metaStatusSchema>;
export type MetaInbound = z.output<typeof metaInboundSchema>;
export type MetaPreference = z.output<typeof metaPreferenceSchema>;
export type MetaTemplateValue = z.output<typeof metaTemplateValueSchema>;
export type MetaAccountValue = z.output<typeof metaAccountValueSchema>;

/** `raw` checked against `schema`; null (and one warning naming the fields) when it doesn't fit. */
export function parseMeta<S extends z.ZodTypeAny>(schema: S, raw: unknown, what: string, context: Record<string, unknown> = {}): z.output<S> | null {
  return parsePayload("Meta", schema, raw, what, context);
}

/** The items of a list that fit `schema`, in order; the rest skipped, with one warning for the list. */
export function parseMetaList<S extends z.ZodTypeAny>(schema: S, raw: readonly unknown[], what: string, context: Record<string, unknown> = {}): Array<z.output<S>> {
  return parsePayloadList("Meta", schema, raw, what, context);
}

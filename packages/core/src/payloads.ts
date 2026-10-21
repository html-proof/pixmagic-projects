/**
 * Checking what another service sends us against a Zod schema, where it enters: Shopify's
 * webhooks and Admin API answers (shopifyPayloads.ts), Meta's WhatsApp webhooks
 * (whatsapp/metaPayloads.ts). One that doesn't fit is logged by field path, never by value, and
 * the caller skips it: retrying would only meet the same payload again.
 */
import type { z } from "zod";
import { logger } from "./logger.js";

/**
 * Where a payload didn't fit, e.g. `line_items.0.price: Expected string, received object`. Paths
 * and Zod's messages only, never the values: a payload can carry a customer's details.
 */
function problems(error: z.ZodError): string[] {
  return error.issues.slice(0, 5).map((i) => {
    // A union's own message is "Invalid input"; its first alternative's says what was wrong.
    const message = (i.code === "invalid_union" ? i.unionErrors[0]?.issues[0]?.message : undefined) ?? i.message;
    return `${i.path.join(".") || "(payload)"}: ${message}`;
  });
}

/**
 * `raw` checked against `schema`. When it doesn't fit: one warning naming the fields that didn't,
 * and null. `sender` names the service in the log ("Shopify", "Meta"), `what` the payload (a
 * webhook topic, "GraphQL order"); `context` adds ids.
 */
export function parsePayload<S extends z.ZodTypeAny>(sender: string, schema: S, raw: unknown, what: string, context: Record<string, unknown> = {}): z.output<S> | null {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  logger.warn({ ...context, payload: what, problems: problems(r.error) }, `${sender} payload doesn't fit its schema; skipped`);
  return null;
}

/** The items of a list that fit `schema`, in order. The rest are skipped, with one warning for the list. */
export function parsePayloadList<S extends z.ZodTypeAny>(
  sender: string,
  schema: S,
  raw: readonly unknown[],
  what: string,
  context: Record<string, unknown> = {},
): Array<z.output<S>> {
  const out: Array<z.output<S>> = [];
  let first: string[] | null = null;
  for (const item of raw) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
    else first ??= problems(r.error);
  }
  if (first) {
    logger.warn({ ...context, payload: what, skipped: raw.length - out.length, of: raw.length, problems: first }, `${sender} payload doesn't fit its schema; skipped`);
  }
  return out;
}

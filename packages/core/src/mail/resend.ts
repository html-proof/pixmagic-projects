import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../env.js";
import type { Mailer } from "../notify.js";
import type { FetchLike } from "../shopify.js";
import { MailError, withoutAddresses, type DeliveryStatus, type MailFailure } from "./types.js";

/**
 * Resend (resend.com): transactional email over HTTPS, sending to any recipient once the sending
 * domain is verified (DKIM and SPF records on bizinsights.io), with delivery, bounce and complaint
 * events sent back to POST /webhooks/email/resend. The API key lives in Secrets Manager
 * (RESEND_API_KEY) and never reaches the browser.
 */
const API = "https://api.resend.com/emails";

/** Resend's error names (docs: api-reference/errors) that a later attempt can get past. */
const TRANSIENT = new Set(["rate_limit_exceeded", "daily_quota_exceeded", "monthly_quota_exceeded", "concurrent_idempotent_requests", "resource_locked", "application_error", "internal_server_error", "service_unavailable"]);

function failureOf(status: number, name: string, message: string): MailFailure {
  if (TRANSIENT.has(name) || status === 429 || status >= 500) return "transient";
  // 403 validation_error: "testing mode only allows sending to your own address", "the from domain
  // isn't verified"; 401/403 for a key that is missing, wrong or suspended. The account is the
  // problem, not the message.
  if (status === 401 || status === 403) return "not_allowed";
  if (/domain.*not verified|verify a domain|own email address/i.test(message)) return "not_allowed";
  return "permanent";
}

export function resendMailer(o: { apiKey: string; fetchImpl?: FetchLike }): Mailer {
  const fetchImpl = o.fetchImpl ?? fetch;
  return {
    async send(to, subject, text, html, opts) {
      // Read before the request: a configuration problem is ours to fix, not a network failure to retry.
      const from = env().EMAIL_FROM;
      let res: Response;
      try {
        res = await fetchImpl(API, {
          method: "POST",
          headers: {
            authorization: `Bearer ${o.apiKey}`,
            "content-type": "application/json",
            ...(opts?.idempotencyKey ? { "idempotency-key": opts.idempotencyKey.slice(0, 256) } : {}),
          },
          body: JSON.stringify({
            from,
            to: [to],
            subject,
            text,
            ...(html ? { html } : {}),
            ...(opts?.replyTo ? { reply_to: opts.replyTo } : {}),
          }),
        });
      } catch (err) {
        throw new MailError(`Resend unreachable: ${withoutAddresses(err instanceof Error ? err.message : String(err))}`, "resend", "transient", "network");
      }
      const json = (await res.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
      if (!res.ok) {
        const name = json.name ?? `http_${res.status}`;
        const message = withoutAddresses(json.message ?? `Resend answered ${res.status}`);
        const retry = Number(res.headers.get("retry-after"));
        throw new MailError(`Resend send failed (${res.status} ${name}): ${message}`, "resend", failureOf(res.status, name, message), name, Number.isFinite(retry) && retry > 0 ? retry : undefined);
      }
      return { provider: "resend", messageId: json.id ?? null };
    },
  };
}

// ---------------------------------------------------------------------------
// Webhooks (signed by Svix: https://docs.svix.com/receiving/verifying-payloads/how-manual)
// ---------------------------------------------------------------------------

/** How old a webhook's timestamp may be (either way) before it is refused as a replay. */
export const WEBHOOK_TOLERANCE_SEC = 5 * 60;

/**
 * Whether a webhook request really comes from Resend: an HMAC-SHA256 over `id.timestamp.body` with
 * the endpoint's signing secret (`whsec_` + base64), compared in constant time against each `v1,`
 * signature in the header, and a timestamp within five minutes.
 */
export function verifyResendWebhook(
  secret: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  rawBody: string,
  now = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > WEBHOOK_TOLERANCE_SEC) return false;
  let key: Buffer;
  try {
    key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  } catch {
    return false;
  }
  if (!key.length) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  for (const part of signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

const resendEvent = z.object({
  type: z.string(),
  created_at: z.string().optional(),
  data: z
    .object({
      email_id: z.string().optional(),
      created_at: z.string().optional(),
      bounce: z.object({ type: z.string().optional(), subType: z.string().optional(), message: z.string().optional() }).partial().optional(),
      failed: z.object({ reason: z.string().optional() }).partial().optional(),
    })
    .passthrough(),
});

/** The delivery events we record, and the status each one means. Opens and clicks aren't tracked. */
const EVENT_STATUS: Record<string, DeliveryStatus> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "failed",
};

export interface ProviderEvent {
  provider: string;
  messageId: string;
  status: DeliveryStatus;
  at: Date;
  errorCode: string | null;
  errorMessage: string | null;
}

/** A Resend webhook body as a delivery event, or null for events we don't record (or can't read). */
export function parseResendEvent(body: unknown): ProviderEvent | null {
  const parsed = resendEvent.safeParse(body);
  if (!parsed.success) return null;
  const e = parsed.data;
  const status = EVENT_STATUS[e.type];
  if (!status || !e.data.email_id) return null;
  const at = new Date(e.created_at ?? e.data.created_at ?? Date.now());
  const bounce = e.data.bounce;
  return {
    provider: "resend",
    messageId: e.data.email_id,
    status,
    at: Number.isNaN(at.getTime()) ? new Date() : at,
    errorCode: e.type === "email.suppressed" ? "suppressed" : bounce ? [bounce.type, bounce.subType].filter(Boolean).join(":") || "bounced" : status === "failed" ? "failed" : null,
    errorMessage: bounce?.message ? withoutAddresses(bounce.message) : e.data.failed?.reason ? withoutAddresses(e.data.failed.reason) : null,
  };
}

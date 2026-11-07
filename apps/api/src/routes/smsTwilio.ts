import type { Context } from "hono";
import { env, logger } from "@app/core";
import { applyTwilioInbound, TWILIO_INBOUND_PATH, TWILIO_STATUS_PATH, twilioStatusEvent, validTwilioSignature } from "@app/core/sms";
import { clientIp, type Deps } from "../context.js";
import type { App } from "../app.js";
import { LIMITS } from "../rateLimit.js";

/** An empty answer to a reply: nothing is texted back (Twilio's own STOP confirmation still goes). */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * Twilio's webhooks for Customer Messaging (docs/sms.md, "Twilio"), outside the CSRF check and the
 * per-IP limit (/webhooks/*), like the other machine endpoints:
 *  - POST /webhooks/sms/twilio/status: a text's status report (the StatusCallback each send names,
 *    with its job and workspace in the query) → the smsEvents queue, in the shape AWS's events
 *    have, for the same handler (core/sms/delivery.ts).
 *  - POST /webhooks/sms/twilio/inbound: a text a customer sent to a platform number or service
 *    (set in Twilio's console) → a STOP puts the number on the stores' suppression lists at once.
 * Each must carry X-Twilio-Signature made with TWILIO_AUTH_TOKEN over the address Twilio called:
 * API_URL with the route and the query it was called with, then the form's fields. Nothing else is
 * read before that check. Answers carry no details.
 */
export function smsTwilioRoutes(app: App, deps: Deps) {
  /** The form Twilio posted, once its signature checks out; null otherwise. */
  async function signedForm(c: Context, path: string): Promise<URLSearchParams | null> {
    const token = env().TWILIO_AUTH_TOKEN.trim();
    if (!token) return null;
    const form = new URLSearchParams(await c.req.text());
    const url = `${env().API_URL.replace(/\/+$/, "")}${path}${new URL(c.req.url).search}`;
    return validTwilioSignature(token, url, form, c.req.header("x-twilio-signature")) ? form : null;
  }

  async function refuse(c: Context, what: string) {
    // Anyone can post here: past a few refusals per address they're answered 429 and no longer logged.
    const n = await deps.coord.hit(`rl:sms-unsigned:${clientIp(c)}`, LIMITS.smsUnsignedIp.windowSec).catch(() => 0);
    if (n > LIMITS.smsUnsignedIp.max) return c.json({ error: "rate_limited" }, 429, { "retry-after": String(LIMITS.smsUnsignedIp.windowSec) });
    if (n <= 5) logger.warn({ ip: clientIp(c), configured: !!env().TWILIO_AUTH_TOKEN.trim(), what }, "twilio webhook rejected: its signature didn't verify");
    return c.json({ error: "invalid_signature" }, 403);
  }

  app.post(TWILIO_STATUS_PATH, async (c) => {
    const form = await signedForm(c, TWILIO_STATUS_PATH);
    if (!form) return refuse(c, "status");
    const event = twilioStatusEvent(form, new URL(c.req.url).searchParams);
    // A status that says nothing about delivery (a reply's "received", a "scheduled") is answered and dropped.
    if (event) await deps.queues.smsEvents.send(event);
    return c.body(null, 204);
  });

  app.post(TWILIO_INBOUND_PATH, async (c) => {
    const form = await signedForm(c, TWILIO_INBOUND_PATH);
    if (!form) return refuse(c, "inbound");
    await applyTwilioInbound(form);
    return c.body(EMPTY_TWIML, 200, { "content-type": "text/xml; charset=utf-8" });
  });
}

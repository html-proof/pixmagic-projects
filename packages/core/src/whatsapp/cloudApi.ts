/**
 * Meta's WhatsApp Cloud API for a connected number (docs/whatsapp.md, "Sending"): messages
 * (POST /{phone-number-id}/messages), attachments (POST /{phone-number-id}/media), the number's own
 * details (GET /{phone-number-id}), and the account's message templates (POST and GET
 * /{waba-id}/message_templates). Every call goes through metaGraph.ts with the business's own token
 * (encrypted on the connection row) and bizinsights' appsecret_proof, and has a time limit.
 *
 * Meta's answer to a failed call is sorted once, here (CloudApiError's kind), so the sender, the
 * templates and the connection check each decide from the kind, never from Meta's words:
 *  - a call that never reached Meta (the connection refused, the name didn't resolve) may be made
 *    again; a send that may have arrived (it timed out, the connection dropped, Meta answered 5xx)
 *    is "uncertain" and is never repeated by itself: a second would reach the customer twice;
 *  - Meta's codes (META_ERRORS): 190 and the permission errors mean its access for bizinsights ended
 *    (reconnect); 130429, 4 and 80007 are its throughput limits and 131056 the limit per customer
 *    (wait, then send); 131047 the 24-hour customer service window; 131026 undeliverable; 132xxx a
 *    template problem; 131030 a test number's list of allowed recipients; each in plain words.
 *
 * The Cloud API has no "is this number on WhatsApp?": a number that isn't is known only afterwards,
 * from Meta's report that the message failed (131026).
 */
import type { WappConnection } from "@app/db";
import { z } from "zod";
import { env } from "../env.js";
import { providerDetail } from "../errors.js";
import { graphCall, type GraphFailure } from "../metaGraph.js";
import type { FetchLike } from "../shopify.js";
import { waDecrypt, type WaDeps } from "./common.js";

export interface MetaApp {
  appId: string;
  appSecret: string;
  configId: string;
  version: string;
  verifyToken: string;
}

/** What connecting through Meta still lacks on this server, by setting name (empty: it can be offered). */
export function cloudApiMissing(): string[] {
  const e = env();
  const appId = e.WHATSAPP_APP_ID || e.META_APP_ID;
  const secret = e.WHATSAPP_APP_SECRET || (!e.WHATSAPP_APP_ID || e.WHATSAPP_APP_ID === e.META_APP_ID ? e.META_APP_SECRET : "");
  return [
    !appId ? "WHATSAPP_APP_ID" : null,
    !e.WHATSAPP_CONFIG_ID ? "WHATSAPP_CONFIG_ID" : null,
    !secret ? "WHATSAPP_APP_SECRET" : null,
    !e.WHATSAPP_WEBHOOK_VERIFY_TOKEN ? "WHATSAPP_WEBHOOK_VERIFY_TOKEN" : null,
  ].filter((x): x is string => !!x);
}

/** bizinsights' Meta app for WhatsApp (its own, or the Meta Ads app's), or null until every setting is there. */
export function metaApp(): MetaApp | null {
  if (cloudApiMissing().length) return null;
  const e = env();
  const appId = e.WHATSAPP_APP_ID || e.META_APP_ID;
  const appSecret = e.WHATSAPP_APP_SECRET || e.META_APP_SECRET;
  return { appId, appSecret, configId: e.WHATSAPP_CONFIG_ID, version: e.WHATSAPP_API_VERSION, verifyToken: e.WHATSAPP_WEBHOOK_VERIFY_TOKEN };
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type CloudErrorKind =
  /** bizinsights' Meta app isn't set up on this server. */
  | "not_configured"
  /** Nothing answered: for a send, `uncertain` says whether it may have arrived all the same. */
  | "unreachable"
  | "timeout"
  /** Meta failed on it (5xx, or its own "try again" codes). */
  | "server"
  /** Meta's throughput limits for the number, the account or the app: wait, then send. */
  | "rate_limited"
  /** Too many messages to this one customer in a short time (131056): wait, then send. */
  | "pair_rate_limited"
  /** Meta's access for bizinsights ended, or doesn't cover this number: the merchant connects again. */
  | "auth"
  /** More than 24 hours since the customer last wrote: only an approved template may go (131047). */
  | "outside_window"
  /** WhatsApp couldn't deliver to this number (131026). */
  | "undeliverable"
  /** Meta refused the template: missing, paused, disabled, or its values don't fit (132xxx). */
  | "template"
  /** A test number, which sends only to the numbers listed on it (131030). */
  | "recipient_not_allowed"
  /** The account or the number can't send at all (locked, payment, policy, display name). */
  | "account"
  /** Any other refusal of this one request. */
  | "refused";

export class CloudApiError extends Error {
  constructor(
    public readonly kind: CloudErrorKind,
    /** The HTTP status (0 when nothing answered). */
    public readonly status: number,
    /** Meta's error code (null when nothing answered). */
    public readonly metaCode: number | null,
    /** What happened, for the merchant: the plain words for Meta's code, or Meta's own reason cleaned (providerDetail). */
    public readonly detail: string,
    /** For a send: whether it may have reached the customer although the call failed. */
    public readonly uncertain = false,
  ) {
    super(`WhatsApp Cloud API ${kind} (${status}${metaCode !== null ? `, Meta #${metaCode}` : ""})`);
    this.name = "CloudApiError";
  }
}

interface MetaErrorInfo {
  kind: CloudErrorKind;
  text: string;
}

/** Meta's WhatsApp error codes bizinsights acts on, with what each means for the merchant. */
const META_ERRORS: Record<number, MetaErrorInfo> = {
  0: { kind: "auth", text: "Meta didn't accept bizinsights' access to this number. Connect WhatsApp again." },
  1: { kind: "server", text: "Meta's WhatsApp service had a problem with the request." },
  2: { kind: "server", text: "Meta's WhatsApp service was briefly unavailable." },
  4: { kind: "rate_limited", text: "Meta asked bizinsights to make fewer calls for a while." },
  10: { kind: "auth", text: "Meta says bizinsights isn't allowed to send for this number any more. Connect WhatsApp again." },
  190: { kind: "auth", text: "Meta's access for bizinsights has ended (it expired, or it was removed in Meta's business settings). Connect WhatsApp again." },
  368: { kind: "account", text: "Meta has temporarily blocked this WhatsApp Business account for breaking its policies. Check WhatsApp Manager." },
  80007: { kind: "rate_limited", text: "This WhatsApp Business account reached Meta's limit of calls for now." },
  130429: { kind: "rate_limited", text: "Meta asked bizinsights to send more slowly from this number." },
  130472: { kind: "refused", text: "Meta held this message back: the customer's number is part of one of Meta's experiments." },
  130497: { kind: "account", text: "Meta doesn't let this account message customers in that country." },
  131000: { kind: "server", text: "Meta's WhatsApp service had a problem sending it." },
  131005: { kind: "auth", text: "Meta refused bizinsights' access to this number. Connect WhatsApp again." },
  131008: { kind: "refused", text: "Meta said something the message needs was missing." },
  131009: { kind: "refused", text: "Meta said a value in the message isn't valid." },
  131016: { kind: "server", text: "Meta's WhatsApp service was overloaded." },
  131021: { kind: "refused", text: "A number can't send a message to itself." },
  131026: { kind: "undeliverable", text: "WhatsApp couldn't deliver it to this number: it may not be on WhatsApp, or its app may need updating." },
  131030: {
    kind: "recipient_not_allowed",
    text: "This is still Meta's test number, which sends only to the numbers added to it (WhatsApp Manager → API Setup → To). Add this number there, or connect your business's own number.",
  },
  131031: { kind: "account", text: "Meta has locked this WhatsApp Business account. Check WhatsApp Manager." },
  131037: { kind: "account", text: "Meta hasn't approved this number's display name yet. Check WhatsApp Manager → Phone numbers." },
  131042: { kind: "account", text: "Meta needs a valid payment method on this WhatsApp Business account (WhatsApp Manager → Payment settings)." },
  131045: { kind: "account", text: "The number isn't fully registered with Meta. Connect WhatsApp again." },
  131047: {
    kind: "outside_window",
    text: "More than 24 hours have passed since this number last wrote to your business, so Meta only delivers a message template it approved. (For your own number: send any WhatsApp message to your business number first, then try again.)",
  },
  131048: { kind: "account", text: "Meta is limiting this number because too many people blocked or reported its messages." },
  131049: { kind: "refused", text: "Meta chose not to deliver this marketing message, to keep people from getting too many." },
  131050: { kind: "refused", text: "The customer stopped marketing messages from your business in WhatsApp." },
  131051: { kind: "refused", text: "WhatsApp doesn't support this kind of message." },
  131052: { kind: "refused", text: "WhatsApp couldn't download the attachment." },
  131053: { kind: "refused", text: "Meta couldn't take the attachment (its type or size)." },
  131056: { kind: "pair_rate_limited", text: "Too many messages to this customer in a short time: Meta asked to wait." },
  131057: { kind: "rate_limited", text: "Meta is updating this WhatsApp Business account; it goes once Meta finishes." },
  132000: { kind: "template", text: "The template's values don't match the ones Meta approved." },
  132001: { kind: "template", text: "Meta has no approved template by this name in this language." },
  132005: { kind: "template", text: "The template with its values is longer than Meta allows." },
  132007: { kind: "template", text: "The template with its values breaks Meta's formatting rules." },
  132012: { kind: "template", text: "A template value isn't in the format Meta expects." },
  132015: { kind: "template", text: "Meta paused this template because its quality dropped." },
  132016: { kind: "template", text: "Meta disabled this template." },
  133004: { kind: "server", text: "Meta's WhatsApp service was briefly unavailable." },
  133010: { kind: "auth", text: "The number isn't registered with Meta's Cloud API any more. Connect WhatsApp again." },
};

/** The kind and the merchant's words for one of Meta's codes (the send's answer, or a failed status report). */
export function metaErrorInfo(code: number | null, fallback?: string | null): MetaErrorInfo {
  const known = code !== null ? META_ERRORS[code] : undefined;
  if (known) return known;
  if (code !== null && code >= 132000 && code < 133000) return { kind: "template", text: "Meta refused the message template." };
  if (code !== null && code >= 200 && code <= 299) return META_ERRORS[10]!;
  const why = providerDetail(fallback);
  return { kind: "refused", text: why ? `WhatsApp refused it: ${why}` : "WhatsApp refused it." };
}

/** Network errors after which the request certainly never reached Meta (a send may be tried again). */
const NEVER_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const TIMED_OUT = new Set(["TimeoutError", "AbortError", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

/** A failed Graph call as a CloudApiError. `send`: the call delivers a message (an unclear failure may have gone out). */
export function cloudFailure(f: GraphFailure, send: boolean): CloudApiError {
  if (f.reason === "network") {
    const never = NEVER_CONNECTED.has(f.networkCode ?? "");
    const timedOut = TIMED_OUT.has(f.networkCode ?? "");
    return new CloudApiError(timedOut ? "timeout" : "unreachable", 0, null, timedOut ? "Meta's WhatsApp service didn't answer in time." : "Meta's WhatsApp service couldn't be reached.", send && !never);
  }
  if (f.reason === "bad_link") return new CloudApiError("refused", f.status, null, "Meta's answer pointed somewhere bizinsights doesn't follow.");
  const info = f.code === null && f.status >= 500 ? { kind: "server" as const, text: "Meta's WhatsApp service had a problem with the request." } : f.code === null && f.status === 401 ? META_ERRORS[190]! : metaErrorInfo(f.code, f.details || f.userMessage || f.message);
  // Meta failed while handling a send: it may have gone out before it failed.
  return new CloudApiError(info.kind, f.status, f.code, info.text, send && (info.kind === "server" || f.status >= 500));
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** Each call gives up after this long (an upload after twice that). */
const CALL_TIMEOUT_MS = 15_000;

/** The business's Meta token, decrypted (server side only). The column keeps the name it had when Evolution API held tokens. */
export function businessToken(c: Pick<WappConnection, "storeId" | "instanceTokenEnc">): string {
  if (!c.instanceTokenEnc) throw new CloudApiError("auth", 0, null, "bizinsights no longer holds Meta's access for this number. Connect WhatsApp again.");
  return waDecrypt(c.storeId, "instance_token", c.instanceTokenEnc);
}

type Conn = Pick<WappConnection, "storeId" | "instanceTokenEnc" | "phoneNumberId" | "wabaId">;

interface CallContext {
  app: MetaApp;
  fetchImpl: FetchLike;
  token: string;
}

function contextFor(conn: Conn, deps: Pick<WaDeps, "fetchImpl">): CallContext {
  const app = metaApp();
  if (!app) throw new CloudApiError("not_configured", 0, null, "Connecting WhatsApp isn't set up on bizinsights yet.");
  return { app, fetchImpl: deps.fetchImpl, token: businessToken(conn) };
}

function call<T>(c: CallContext, method: "GET" | "POST" | "DELETE", path: string, opts: { query?: Record<string, string>; json?: unknown; multipart?: FormData; send?: boolean; timeoutMs?: number } = {}): Promise<T> {
  return graphCall<T>(
    c.fetchImpl,
    { version: c.app.version, method, path, token: c.token, appSecret: c.app.appSecret, query: opts.query, json: opts.json, multipart: opts.multipart, signal: AbortSignal.timeout(opts.timeoutMs ?? CALL_TIMEOUT_MS) },
    (f) => cloudFailure(f, !!opts.send),
  );
}

const need = (v: string | null, what: string): string => {
  if (!v) throw new CloudApiError("auth", 0, null, `This connection has no ${what} any more. Connect WhatsApp again.`);
  return v;
};

/** What one message to WhatsApp carries. */
export interface CloudMessage {
  /** The customer's number: E.164 digits without the plus. */
  to: string;
  /** The text, or the attachment's caption. */
  text: string;
  /** A template Meta approved, with its body's values in order (the message is then the template). */
  template?: { name: string; language: string; params: string[] } | null;
  /** An image or a PDF, base64 (uploaded to Meta first). */
  media?: { kind: "image" | "document"; mime: string; name: string; base64: string } | null;
  /** Comes back on each of Meta's status reports for the message (biz_opaque_callback_data): bizinsights' message id. */
  reference: string;
}

const sentSchema = z.object({ messages: z.array(z.object({ id: z.string().min(1), message_status: z.string().nullish() }).passthrough()).min(1) }).passthrough();

/**
 * One message to WhatsApp (POST /{phone-number-id}/messages). Meta's answer means it accepted the
 * message, nothing more: whether it was sent, delivered and read comes in its status reports.
 */
export async function sendCloudMessage(deps: Pick<WaDeps, "fetchImpl">, conn: Conn, m: CloudMessage): Promise<{ id: string; status: string | null }> {
  const c = contextFor(conn, deps);
  const phoneNumberId = need(conn.phoneNumberId, "phone number");
  let content: Record<string, unknown>;
  if (m.template) {
    const { name, language, params } = m.template;
    content = { type: "template", template: { name, language: { code: language }, components: params.length ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] : [] } };
  } else if (m.media) {
    const id = await uploadCloudMedia(c, phoneNumberId, m.media);
    const caption = m.text ? { caption: m.text } : {};
    content = m.media.kind === "image" ? { type: "image", image: { id, ...caption } } : { type: "document", document: { id, filename: m.media.name, ...caption } };
  } else {
    content = { type: "text", text: { body: m.text, preview_url: true } };
  }
  const body = await call<unknown>(c, "POST", `${phoneNumberId}/messages`, { json: { messaging_product: "whatsapp", recipient_type: "individual", to: m.to, ...content, biz_opaque_callback_data: m.reference }, send: true });
  const sent = sentSchema.safeParse(body);
  // A 2xx without a message id: Meta may or may not have taken it.
  if (!sent.success) throw new CloudApiError("server", 200, null, "Meta's answer to the send had no message id.", true);
  const first = sent.data.messages[0]!;
  return { id: first.id, status: first.message_status ?? null };
}

/** An attachment to Meta (POST /{phone-number-id}/media): Meta keeps it 30 days and the message names it by id. Nothing reaches the customer, so a failure here is never uncertain. */
async function uploadCloudMedia(c: CallContext, phoneNumberId: string, media: NonNullable<CloudMessage["media"]>): Promise<string> {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", media.mime);
  form.set("file", new Blob([Buffer.from(media.base64, "base64")], { type: media.mime }), media.name);
  const r = await call<{ id?: unknown }>(c, "POST", `${phoneNumberId}/media`, { multipart: form, timeoutMs: CALL_TIMEOUT_MS * 2 });
  if (typeof r.id !== "string" || !r.id) throw new CloudApiError("refused", 200, null, "Meta didn't take the attachment.");
  return r.id;
}

const numberSchema = z
  .object({ id: z.string(), display_phone_number: z.string().nullish(), verified_name: z.string().nullish(), quality_rating: z.string().nullish(), status: z.string().nullish(), platform_type: z.string().nullish() })
  .passthrough();

/** The number as Meta has it now (GET /{phone-number-id}): the connection check. */
export async function cloudNumberInfo(deps: Pick<WaDeps, "fetchImpl">, conn: Conn) {
  const c = contextFor(conn, deps);
  const body = await call<unknown>(c, "GET", need(conn.phoneNumberId, "phone number"), { query: { fields: "id,display_phone_number,verified_name,quality_rating,status,platform_type" } });
  const r = numberSchema.safeParse(body);
  if (!r.success) throw new CloudApiError("server", 200, null, "Meta's answer about the number didn't fit what bizinsights reads.");
  return r.data;
}

/**
 * Stops Meta sending this account's webhooks to bizinsights' app (DELETE /{waba-id}/subscribed_apps):
 * disconnecting the account's last number on bizinsights. Best effort; never throws.
 */
export async function unsubscribeCloudAccount(deps: Pick<WaDeps, "fetchImpl">, conn: Conn): Promise<boolean> {
  try {
    await call(contextFor(conn, deps), "DELETE", `${need(conn.wabaId, "WhatsApp Business account")}/subscribed_apps`);
    return true;
  } catch {
    return false;
  }
}

/** Submits a template for Meta's review (POST /{waba-id}/message_templates). */
export async function createCloudTemplate(deps: Pick<WaDeps, "fetchImpl">, conn: Conn, input: { name: string; category: "UTILITY" | "MARKETING"; language: string; components: unknown[] }) {
  const body = await call<unknown>(contextFor(conn, deps), "POST", `${need(conn.wabaId, "WhatsApp Business account")}/message_templates`, { json: input });
  return z.object({ id: z.string().optional(), status: z.string().optional(), category: z.string().optional() }).passthrough().parse(body ?? {});
}

const templateListSchema = z
  .object({
    data: z.array(z.object({ id: z.string(), name: z.string(), language: z.string(), status: z.string(), category: z.string().nullish(), rejected_reason: z.string().nullish() }).passthrough()).default([]),
    paging: z.object({ next: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

/** The account's templates with Meta's review of each (GET /{waba-id}/message_templates), every page (at most 20). */
export async function listCloudTemplates(deps: Pick<WaDeps, "fetchImpl">, conn: Conn) {
  const c = contextFor(conn, deps);
  const out: z.output<typeof templateListSchema>["data"] = [];
  let path: string | null = `${need(conn.wabaId, "WhatsApp Business account")}/message_templates`;
  let query: Record<string, string> | undefined = { fields: "id,name,language,status,category,rejected_reason", limit: "100" };
  for (let page = 0; path && page < 20; page++) {
    const r = templateListSchema.parse(await call<unknown>(c, "GET", path, { query }));
    out.push(...r.data);
    path = r.paging?.next ?? null;
    query = undefined;
  }
  return out;
}

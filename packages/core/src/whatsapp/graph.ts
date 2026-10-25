/**
 * The WhatsApp Business Platform (Cloud API) through Meta's Graph API, server to server: Embedded
 * Signup's code exchange and token check, the business account and its numbers, webhooks,
 * registration, templates and sending. Every call goes through core/metaGraph.ts (the token in the
 * Authorization header, paging links only to graph.facebook.com) and is a plain fetch, so tests
 * stand in for Meta. Tokens never reach a browser or a log.
 */
import { classifyMetaError, type ErrorAction, type TemplateComponent } from "@app/shared";
import { graphCall, type GraphFailure } from "../metaGraph.js";
import type { FetchLike } from "../shopify.js";
import { waAppSecret, waVersion, type WaPlatform } from "./common.js";

export class WhatsappApiError extends Error {
  override name = "WhatsappApiError";
  readonly action: ErrorAction | "network";
  constructor(
    /** 0 when nothing answered. */
    readonly httpStatus: number,
    readonly code: number | null,
    readonly subcode: number | null,
    /** Meta's title or error type: for logs and the message's error title. */
    readonly title: string,
    /** Meta's own words, for the logs (shown to a merchant only through providerDetail). */
    readonly details: string | null,
  ) {
    super(`WhatsApp API ${httpStatus}${code !== null ? ` (#${code})` : ""}: ${details || title}`);
    // No answer at all: Meta may or may not have the request (a send is then "uncertain").
    this.action = httpStatus === 0 ? "network" : classifyMetaError(code, httpStatus);
  }
}

function waError(f: GraphFailure): WhatsappApiError {
  if (f.reason === "network") return new WhatsappApiError(0, null, null, "network", f.message);
  return new WhatsappApiError(f.status, f.code, f.subcode, f.userTitle || f.type || "error", f.details || f.userMessage || f.message || f.text || null);
}

interface CallOpts {
  query?: Record<string, string>;
  body?: unknown;
  version?: string;
  /** An app token (`<id>|<secret>`) carries its secret and takes no proof. */
  appToken?: boolean;
}

/**
 * One Graph API call with the business's token (or bizinsights' app token). Calls with a business
 * token carry `appsecret_proof` when bizinsights' app secret is known: the token was issued to it.
 */
export function graph<T>(fetchImpl: FetchLike, token: string, method: "GET" | "POST" | "DELETE", path: string, opts: CallOpts = {}): Promise<T> {
  const secret = opts.appToken ? "" : waAppSecret();
  return graphCall<T>(fetchImpl, { version: opts.version ?? waVersion(), method, path, token, ...(secret ? { appSecret: secret } : {}), query: opts.query, json: opts.body }, waError);
}

const appToken = (p: WaPlatform) => `${p.appId}|${p.appSecret}`;

/** Embedded Signup's code lives 30 seconds: exchange it for the business's token at once. */
export async function exchangeSignupCode(p: WaPlatform, code: string, fetchImpl: FetchLike): Promise<string> {
  // The one call without a token: the app proves itself with its id and secret.
  const r = await graphCall<{ access_token?: string }>(fetchImpl, { version: p.version, method: "GET", path: "oauth/access_token", query: { client_id: p.appId, client_secret: p.appSecret, code } }, waError);
  if (!r.access_token) throw new WhatsappApiError(400, null, null, "oauth", "Meta returned no token for the sign-in code");
  return r.access_token;
}

/**
 * A fresh token for one that expires (bizinsights' Embedded Signup configuration issues 60-day
 * system user tokens): Meta's refresh of an expiring system user token. Each refresh starts another
 * 60 days, and the old token keeps working until its own expiry.
 */
export async function refreshBusinessToken(p: WaPlatform, token: string, fetchImpl: FetchLike): Promise<{ token: string; expiresAt: Date | null }> {
  const r = await graphCall<{ access_token?: string; expires_in?: number }>(
    fetchImpl,
    { version: p.version, method: "GET", path: "oauth/access_token", query: { grant_type: "fb_exchange_token", client_id: p.appId, client_secret: p.appSecret, set_token_expires_in_60_days: "true", fb_exchange_token: token } },
    waError,
  );
  if (!r.access_token) throw new WhatsappApiError(400, null, null, "oauth", "Meta returned no token for the refresh");
  return { token: r.access_token, expiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000) : null };
}

export interface TokenInfo {
  appId: string | null;
  valid: boolean;
  scopes: string[];
  /** The WhatsApp Business Accounts the token was given (Meta's granular scopes); empty when Meta doesn't list them. */
  wabaIds: string[];
  /** When it expires; null for a token that doesn't (a business integration system user token). */
  expiresAt: Date | null;
}

/** What Meta says of a token, asked with bizinsights' app token (Meta's token inspector). */
export async function inspectToken(p: WaPlatform, token: string, fetchImpl: FetchLike): Promise<TokenInfo> {
  const r = await graph<{ data?: { app_id?: string; is_valid?: boolean; scopes?: string[]; expires_at?: number; granular_scopes?: Array<{ scope?: string; target_ids?: string[] }> } }>(fetchImpl, appToken(p), "GET", "debug_token", {
    query: { input_token: token },
    appToken: true,
    version: p.version,
  });
  const d = r.data ?? {};
  const targets = (d.granular_scopes ?? []).filter((g) => g.scope === "whatsapp_business_management" || g.scope === "whatsapp_business_messaging").flatMap((g) => g.target_ids ?? []);
  return {
    appId: d.app_id ? String(d.app_id) : null,
    valid: d.is_valid !== false,
    scopes: d.scopes ?? [],
    wabaIds: [...new Set(targets.map(String))],
    expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : null,
  };
}

export const REQUIRED_SCOPES = ["whatsapp_business_management", "whatsapp_business_messaging"];

export interface WabaInfo {
  id: string;
  name?: string;
  currency?: string;
  timezone_id?: string;
}

export async function getWaba(wabaId: string, token: string, fetchImpl: FetchLike): Promise<WabaInfo> {
  return graph<WabaInfo>(fetchImpl, token, "GET", wabaId, { query: { fields: "id,name,currency,timezone_id" } });
}

export interface PhoneInfo {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  code_verification_status?: string;
  name_status?: string;
  /** CLOUD_API once the number is registered for sending; NOT_APPLICABLE before. */
  platform_type?: string;
  /** CONNECTED, PENDING, DISCONNECTED, FLAGGED, RESTRICTED... */
  status?: string;
  messaging_limit_tier?: string;
}

const PHONE_FIELDS = "id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,platform_type,status";

export async function listPhones(wabaId: string, token: string, fetchImpl: FetchLike): Promise<PhoneInfo[]> {
  const r = await graph<{ data?: PhoneInfo[] }>(fetchImpl, token, "GET", `${wabaId}/phone_numbers`, { query: { fields: PHONE_FIELDS, limit: "100" } });
  return r.data ?? [];
}

/** The number's name, quality and whether it is on the Cloud API, and its messaging limit where Meta still reports it there. */
export async function getPhone(phoneNumberId: string, token: string, fetchImpl: FetchLike): Promise<PhoneInfo> {
  const info = await graph<PhoneInfo>(fetchImpl, token, "GET", phoneNumberId, { query: { fields: PHONE_FIELDS } });
  // Meta has been moving the limit from the number to the business: asked on its own, so a field it
  // no longer has can't fail the whole read.
  try {
    const tier = await graph<{ messaging_limit_tier?: string }>(fetchImpl, token, "GET", phoneNumberId, { query: { fields: "messaging_limit_tier" } });
    if (tier.messaging_limit_tier) info.messaging_limit_tier = tier.messaging_limit_tier;
  } catch (err) {
    if (err instanceof WhatsappApiError && err.action === "reconnect") throw err;
  }
  return info;
}

/** Have the account's webhooks (statuses, replies, template reviews) sent to the token's app: bizinsights'. */
export async function subscribeApp(wabaId: string, token: string, fetchImpl: FetchLike): Promise<void> {
  await graph(fetchImpl, token, "POST", `${wabaId}/subscribed_apps`);
}

/** Whether bizinsights' app is still subscribed to the account (a business can remove it). */
export async function appSubscribed(p: Pick<WaPlatform, "appId">, wabaId: string, token: string, fetchImpl: FetchLike): Promise<boolean> {
  const r = await graph<{ data?: Array<{ whatsapp_business_api_data?: { id?: string }; id?: string }> }>(fetchImpl, token, "GET", `${wabaId}/subscribed_apps`);
  return (r.data ?? []).some((a) => String(a.whatsapp_business_api_data?.id ?? a.id ?? "") === p.appId);
}

export async function unsubscribeApp(wabaId: string, token: string, fetchImpl: FetchLike): Promise<void> {
  await graph(fetchImpl, token, "DELETE", `${wabaId}/subscribed_apps`);
}

/** Register the number with the Cloud API. `pin` becomes (or must match) its two-step verification PIN. */
export async function registerPhone(phoneNumberId: string, pin: string, token: string, fetchImpl: FetchLike): Promise<void> {
  await graph(fetchImpl, token, "POST", `${phoneNumberId}/register`, { body: { messaging_product: "whatsapp", pin } });
}

/** Meta's answer when the number already has a two-step verification PIN other than the one sent. */
export const PIN_MISMATCH_CODES = [133005, 133006];

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: TemplateComponent[];
  rejected_reason?: string;
  quality_score?: { score?: string };
}

/** Every template in the account. */
export async function metaListTemplates(wabaId: string, token: string, fetchImpl: FetchLike): Promise<MetaTemplate[]> {
  const out: MetaTemplate[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await graph<{ data?: MetaTemplate[]; paging?: { cursors?: { after?: string }; next?: string } }>(fetchImpl, token, "GET", `${wabaId}/message_templates`, {
      query: { fields: "id,name,language,category,status,components,rejected_reason,quality_score", limit: "100", ...(after ? { after } : {}) },
    });
    out.push(...(r.data ?? []));
    after = r.paging?.next ? r.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

/** Submit a template for Meta's review. */
export async function metaCreateTemplate(
  wabaId: string,
  token: string,
  t: { name: string; language: string; category: string; components: Array<Record<string, unknown>> },
  fetchImpl: FetchLike,
): Promise<{ id: string; status: string; category: string }> {
  const r = await graph<{ id?: string; status?: string; category?: string }>(fetchImpl, token, "POST", `${wabaId}/message_templates`, { body: t });
  if (!r.id) throw new WhatsappApiError(502, null, null, "no_template_id", "Meta accepted the template but returned no id");
  return { id: String(r.id), status: r.status ?? "PENDING", category: r.category ?? t.category };
}

export async function metaDeleteTemplate(wabaId: string, token: string, name: string, metaId: string, fetchImpl: FetchLike): Promise<void> {
  await graph(fetchImpl, token, "DELETE", `${wabaId}/message_templates`, { query: { name, hsm_id: metaId } });
}

/**
 * Send a message. `body` is everything but the envelope (type and its object). Returns Meta's
 * message id. `ref` comes back on every status webhook (`biz_opaque_callback_data`), so a status is
 * matched to its message even before the id has been recorded.
 */
export async function sendMessage(phoneNumberId: string, token: string, to: string, body: Record<string, unknown>, ref: string, fetchImpl: FetchLike): Promise<string> {
  const r = await graph<{ messages?: Array<{ id?: string }> }>(fetchImpl, token, "POST", `${phoneNumberId}/messages`, {
    body: { messaging_product: "whatsapp", recipient_type: "individual", to, biz_opaque_callback_data: ref, ...body },
  });
  const id = r.messages?.[0]?.id;
  if (!id) throw new WhatsappApiError(502, null, null, "no_message_id", "Meta accepted the send but returned no message id");
  return id;
}

/** The webhook fields bizinsights reads (webhook.ts). */
export const WA_WEBHOOK_FIELDS = [
  "messages",
  "user_preferences",
  "message_template_status_update",
  "message_template_quality_update",
  "template_category_update",
  "phone_number_quality_update",
  "phone_number_name_update",
  "account_update",
];

/**
 * Point bizinsights' own app's WhatsApp webhook at bizinsights, so nobody has to paste a callback
 * URL and verify token into Meta's dashboard (Meta checks the URL there and then, with the verify
 * token). A webhook already pointing elsewhere is left alone ("in_use"). "already": it points here
 * with every field.
 */
export async function ensureAppWebhook(p: WaPlatform, callbackUrl: string, fetchImpl: FetchLike): Promise<"set" | "already" | "in_use"> {
  const current = await graph<{ data?: Array<{ object?: string; callback_url?: string; active?: boolean; fields?: Array<{ name?: string } | string> }> }>(fetchImpl, appToken(p), "GET", `${p.appId}/subscriptions`, {
    appToken: true,
    version: p.version,
  });
  const wa = (current.data ?? []).find((s) => s.object === "whatsapp_business_account");
  const names = (wa?.fields ?? []).map((f) => (typeof f === "string" ? f : (f.name ?? "")));
  if (wa?.active && wa.callback_url && wa.callback_url !== callbackUrl) return "in_use";
  if (wa?.active && WA_WEBHOOK_FIELDS.every((f) => names.includes(f))) return "already";
  await graph(fetchImpl, appToken(p), "POST", `${p.appId}/subscriptions`, {
    appToken: true,
    version: p.version,
    query: { object: "whatsapp_business_account", callback_url: callbackUrl, verify_token: p.verifyToken, fields: WA_WEBHOOK_FIELDS.join(",") },
  });
  return "set";
}

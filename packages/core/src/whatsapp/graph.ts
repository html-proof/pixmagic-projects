/**
 * The WhatsApp Business Platform Cloud API, through Meta's Graph API: Embedded Signup's code
 * exchange, the phone number and account, templates, and sending. Server to server only; tokens
 * never reach a browser. Every call is a plain fetch so tests can stand in for Meta.
 */
import { classifyGraphError, type ErrorAction, type TemplateComponent } from "@app/shared";
import { env } from "../env.js";
import type { FetchLike } from "../shopify.js";

const GRAPH = "https://graph.facebook.com";

/** Insights' own Meta app, for Embedded Signup. Null until it is configured (the button then says so). */
export interface WaPlatformConfig {
  appId: string;
  appSecret: string;
  configId: string;
  version: string;
  verifyToken: string;
}

export function waPlatformConfig(): WaPlatformConfig | null {
  const e = env();
  const appId = e.WHATSAPP_APP_ID || e.META_APP_ID;
  const appSecret = e.WHATSAPP_APP_SECRET || e.META_APP_SECRET;
  if (!appId || !appSecret || !e.WHATSAPP_CONFIG_ID) return null;
  return { appId, appSecret, configId: e.WHATSAPP_CONFIG_ID, version: e.WHATSAPP_API_VERSION, verifyToken: e.WHATSAPP_WEBHOOK_VERIFY_TOKEN };
}

/** The app secret that signs webhooks for numbers connected through Embedded Signup. */
export function waPlatformSecret(): string {
  const e = env();
  return e.WHATSAPP_APP_SECRET || e.META_APP_SECRET;
}

export const waVersion = () => env().WHATSAPP_API_VERSION;

export class WhatsappApiError extends Error {
  override name = "WhatsappApiError";
  readonly action: ErrorAction;
  constructor(
    readonly httpStatus: number,
    readonly code: number | null,
    readonly title: string,
    readonly details: string | null,
  ) {
    super(`WhatsApp API ${httpStatus}${code !== null ? ` (#${code})` : ""}: ${details || title}`);
    this.action = classifyGraphError(code, httpStatus);
  }
}

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_title?: string; error_user_msg?: string; error_data?: { details?: string } };
}

export async function graph<T>(
  fetchImpl: FetchLike,
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; version?: string } = {},
): Promise<T> {
  const url = new URL(`${GRAPH}/${opts.version ?? waVersion()}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    // No answer at all: Meta or the network is down. Retryable (no code, 5xx-like).
    throw new WhatsappApiError(503, null, "network", err instanceof Error ? err.message : String(err));
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const e = (json as GraphErrorBody | null)?.error;
    throw new WhatsappApiError(res.status, e?.code ?? null, e?.error_user_title || e?.type || "error", e?.error_data?.details || e?.error_user_msg || e?.message || text.slice(0, 300) || null);
  }
  return json as T;
}

/** Embedded Signup returns a code that lives 30 seconds: exchange it for the business's token at once. */
export async function waExchangeCode(cfg: WaPlatformConfig, code: string, fetchImpl: FetchLike): Promise<string> {
  const url = new URL(`${GRAPH}/${cfg.version}/oauth/access_token`);
  url.searchParams.set("client_id", cfg.appId);
  url.searchParams.set("client_secret", cfg.appSecret);
  url.searchParams.set("code", code);
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), { method: "GET" });
  } catch (err) {
    throw new WhatsappApiError(503, null, "network", err instanceof Error ? err.message : String(err));
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string } & GraphErrorBody;
  if (!res.ok || !body.access_token) {
    throw new WhatsappApiError(res.status || 400, body.error?.code ?? null, body.error?.type ?? "oauth", body.error?.message ?? "The sign-in code was not accepted");
  }
  return body.access_token;
}

export interface WaPhoneInfo {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  code_verification_status?: string;
  name_status?: string;
  platform_type?: string;
  messaging_limit_tier?: string;
}

/** The number's name, quality and whether it is on the Cloud API. */
export async function waPhoneInfo(phoneNumberId: string, token: string, fetchImpl: FetchLike): Promise<WaPhoneInfo> {
  const info = await graph<WaPhoneInfo>(fetchImpl, token, "GET", phoneNumberId, {
    query: { fields: "display_phone_number,verified_name,quality_rating,code_verification_status,name_status,platform_type" },
  });
  // Meta has been moving messaging limits from the number to the business portfolio: ask for the
  // tier on its own, so a field it no longer has can't fail the whole lookup.
  try {
    const tier = await graph<{ messaging_limit_tier?: string }>(fetchImpl, token, "GET", phoneNumberId, { query: { fields: "messaging_limit_tier" } });
    if (tier.messaging_limit_tier) info.messaging_limit_tier = tier.messaging_limit_tier;
  } catch (err) {
    if (err instanceof WhatsappApiError && err.action === "reconnect") throw err;
  }
  return info;
}

export interface WaAccountInfo {
  id: string;
  name?: string;
  owner_business_info?: { id?: string; name?: string };
}

export async function waAccountInfo(wabaId: string, token: string, fetchImpl: FetchLike): Promise<WaAccountInfo> {
  return graph<WaAccountInfo>(fetchImpl, token, "GET", wabaId, { query: { fields: "id,name" } });
}

/** The phone numbers in an account (to check that a manually entered phone number id belongs to it). */
export async function waAccountPhoneIds(wabaId: string, token: string, fetchImpl: FetchLike): Promise<string[]> {
  const r = await graph<{ data?: Array<{ id: string }> }>(fetchImpl, token, "GET", `${wabaId}/phone_numbers`, { query: { fields: "id", limit: "100" } });
  return (r.data ?? []).map((p) => p.id);
}

export interface WaTokenInfo {
  /** The Meta app the token was made for. */
  appId: string | null;
  scopes: string[];
  /** The WhatsApp Business Accounts the token was given; null when Meta doesn't list them. */
  wabaIds: string[] | null;
}

/** What a token can reach: its app, its permissions and the WhatsApp accounts it was given. */
/**
 * What Meta says about a token: its app, permissions and the WhatsApp accounts it was given.
 * `inspector` is the token that asks (Insights' app token `<id>|<secret>` for Embedded Signup
 * tokens); by default the token inspects itself.
 */
export async function waTokenInfo(token: string, fetchImpl: FetchLike, inspector = token): Promise<WaTokenInfo> {
  const r = await graph<{ data?: { app_id?: string; is_valid?: boolean; scopes?: string[]; granular_scopes?: Array<{ scope?: string; target_ids?: string[] }> } }>(fetchImpl, inspector, "GET", "debug_token", {
    query: { input_token: token },
  });
  const d = r.data ?? {};
  if (d.is_valid === false) throw new WhatsappApiError(401, 190, "OAuthException", "The access token isn't valid");
  const targets = (d.granular_scopes ?? []).filter((g) => g.scope === "whatsapp_business_management" || g.scope === "whatsapp_business_messaging").flatMap((g) => g.target_ids ?? []);
  return { appId: d.app_id ?? null, scopes: d.scopes ?? [], wabaIds: targets.length ? [...new Set(targets)] : null };
}

export interface WaNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  platform_type?: string;
  quality_rating?: string;
}

/** The phone numbers in an account, with what a person needs to recognise them. */
export async function waAccountNumbers(wabaId: string, token: string, fetchImpl: FetchLike): Promise<WaNumber[]> {
  const r = await graph<{ data?: WaNumber[] }>(fetchImpl, token, "GET", `${wabaId}/phone_numbers`, {
    query: { fields: "id,display_phone_number,verified_name,platform_type,quality_rating", limit: "100" },
  });
  return r.data ?? [];
}

/** The webhook fields Insights reads (webhook.ts). */
export const WA_WEBHOOK_FIELDS = [
  "messages",
  "user_preferences",
  "message_template_status_update",
  "message_template_quality_update",
  "template_category_update",
  "phone_number_quality_update",
  "account_update",
];

/**
 * Point a merchant's own Meta app's WhatsApp webhook at Insights, so they don't have to paste a
 * callback URL and verify token into Meta's dashboard. Meta checks the URL straight away (the
 * verify-token handshake), so the connection has to be saved first. An app whose WhatsApp webhook
 * already goes somewhere else is left alone ("in_use"): it may be feeding another tool.
 * "already": it points here with every field, so Meta isn't asked again.
 * Throws when Meta refuses the app id and secret (a secret from a different app, say).
 */
export async function waSetAppWebhook(
  app: { appId: string; appSecret: string },
  callbackUrl: string,
  verifyToken: string,
  fetchImpl: FetchLike,
): Promise<"set" | "already" | "in_use"> {
  const appToken = `${app.appId}|${app.appSecret}`;
  const current = await graph<{ data?: Array<{ object?: string; callback_url?: string; active?: boolean; fields?: Array<{ name?: string }> }> }>(
    fetchImpl,
    appToken,
    "GET",
    `${app.appId}/subscriptions`,
  );
  const wa = (current.data ?? []).find((s) => s.object === "whatsapp_business_account");
  if (wa?.active && wa.callback_url && wa.callback_url !== callbackUrl) return "in_use";
  if (wa?.active && WA_WEBHOOK_FIELDS.every((f) => wa.fields?.some((x) => x.name === f))) return "already";
  await graph(fetchImpl, appToken, "POST", `${app.appId}/subscriptions`, {
    query: { object: "whatsapp_business_account", callback_url: callbackUrl, verify_token: verifyToken, fields: WA_WEBHOOK_FIELDS.join(",") },
  });
  return "set";
}

/** Have the account's webhooks (messages, statuses, template reviews) sent to the token's app. */
export async function waSubscribeApp(wabaId: string, token: string, fetchImpl: FetchLike): Promise<void> {
  await graph(fetchImpl, token, "POST", `${wabaId}/subscribed_apps`);
}

/** Register the number with the Cloud API. `pin` becomes (or must match) its two-step verification PIN. */
export async function waRegisterPhone(phoneNumberId: string, pin: string, token: string, fetchImpl: FetchLike): Promise<void> {
  await graph(fetchImpl, token, "POST", `${phoneNumberId}/register`, { body: { messaging_product: "whatsapp", pin } });
}

export interface WaTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: TemplateComponent[];
  rejected_reason?: string;
  quality_score?: { score?: string };
}

/** Every template in the account (paged). */
export async function waListTemplates(wabaId: string, token: string, fetchImpl: FetchLike): Promise<WaTemplate[]> {
  const out: WaTemplate[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await graph<{ data?: WaTemplate[]; paging?: { cursors?: { after?: string }; next?: string } }>(fetchImpl, token, "GET", `${wabaId}/message_templates`, {
      query: { fields: "id,name,language,category,status,components,rejected_reason,quality_score", limit: "100", ...(after ? { after } : {}) },
    });
    out.push(...(r.data ?? []));
    after = r.paging?.next ? r.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

/** Submit a template for Meta's review. */
export async function waCreateTemplate(
  wabaId: string,
  token: string,
  template: { name: string; language: string; category: string; components: Array<Record<string, unknown>> },
  fetchImpl: FetchLike,
): Promise<{ id: string; status: string; category: string }> {
  return graph(fetchImpl, token, "POST", `${wabaId}/message_templates`, { body: template });
}

/** Send a template message. Returns Meta's message id (wamid). */
export async function waSendTemplate(
  phoneNumberId: string,
  token: string,
  to: string,
  template: { name: string; language: string; components: Array<Record<string, unknown>> },
  fetchImpl: FetchLike,
): Promise<string> {
  const r = await graph<{ messages?: Array<{ id: string }> }>(fetchImpl, token, "POST", `${phoneNumberId}/messages`, {
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: { name: template.name, language: { code: template.language }, ...(template.components.length ? { components: template.components } : {}) },
    },
  });
  const id = r.messages?.[0]?.id;
  if (!id) throw new WhatsappApiError(502, null, "no_message_id", "Meta accepted the send but returned no message id");
  return id;
}

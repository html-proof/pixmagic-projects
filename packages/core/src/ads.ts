/**
 * Meta Marketing API and Google Ads API clients: the OAuth handshake ("Continue with Meta" /
 * "Continue with Google"), the ad accounts a person can see, and daily numbers per campaign.
 *
 * Read-only by design: the only permissions asked for are `ads_read` (Meta) and the Google Ads
 * scope used for reporting. Nothing here creates, edits or pauses an ad.
 *
 * Every function takes its keys and a fetch implementation as arguments, so tests run against
 * fakes and nothing in here reads the environment.
 */
import { fromGoogleAdsRow, fromMetaInsight, googleCustomerId, isDay, metaAccountId, type AdDayRow, type GoogleAdsRow, type MetaInsightRow } from "@app/shared";
import type { FetchLike } from "./shopify.js";

/** The person's access was refused or has expired: they have to connect again. */
export class AdsAuthError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** The platform said no for a reason that a retry may fix (rate limits, outages). */
export class AdsRetryableError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Anything else the platform rejected (a bad request, an account we can't read). */
export class AdsApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface AdAccount {
  accountId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  /** Google: the manager account the client is reached through (sent as login-customer-id). */
  loginCustomerId?: string | null;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token stops working, if the platform says. */
  expiresAt: Date | null;
}

const expiry = (seconds: unknown) => (typeof seconds === "number" && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null);

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export interface MetaConfig {
  appId: string;
  appSecret: string;
  /** Graph / Marketing API version, e.g. "v25.0". */
  version: string;
  fetchImpl?: FetchLike;
}

export const META_SCOPES = ["ads_read"];

export function metaAuthorizeUrl(c: MetaConfig, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: c.appId, redirect_uri: redirectUri, state, scope: META_SCOPES.join(","), response_type: "code" });
  return `https://www.facebook.com/${c.version}/dialog/oauth?${q}`;
}

async function metaGet<T>(c: MetaConfig, path: string, params: Record<string, string>): Promise<T> {
  const url = path.startsWith("https://") ? path : `https://graph.facebook.com/${c.version}/${path}?${new URLSearchParams(params)}`;
  const res = await (c.fetchImpl ?? fetch)(url, { method: "GET" });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number; error_subcode?: number } };
  if (res.ok && !body.error) return body;
  const e = body.error ?? {};
  const msg = e.message ?? `Meta returned ${res.status}`;
  // 190: the token is invalid or expired; 102: session expired; 10/200-299: permission missing.
  if (e.code === 190 || e.code === 102 || res.status === 401) throw new AdsAuthError(msg);
  // 4, 17, 32, 613, 80000-80014: rate limits; 1/2: temporary.
  if ([1, 2, 4, 17, 32, 613].includes(e.code ?? 0) || (e.code ?? 0) >= 80000 || res.status === 429 || res.status >= 500) throw new AdsRetryableError(msg);
  throw new AdsApiError(msg, res.status);
}

/** The code from the redirect → a long-lived (about 60 days) user token. */
export async function metaExchangeCode(c: MetaConfig, code: string, redirectUri: string): Promise<TokenSet> {
  const short = await metaGet<{ access_token: string }>(c, "oauth/access_token", { client_id: c.appId, client_secret: c.appSecret, redirect_uri: redirectUri, code });
  const long = await metaGet<{ access_token: string; expires_in?: number }>(c, "oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: c.appId,
    client_secret: c.appSecret,
    fb_exchange_token: short.access_token,
  });
  return { accessToken: long.access_token, refreshToken: null, expiresAt: expiry(long.expires_in) };
}

/** Ad accounts the person can read. */
export async function metaAdAccounts(c: MetaConfig, accessToken: string): Promise<AdAccount[]> {
  const out: AdAccount[] = [];
  let next: string | null = null;
  let page = await metaGet<{ data: Array<{ id: string; name?: string; currency?: string; timezone_name?: string }>; paging?: { next?: string } }>(c, "me/adaccounts", {
    fields: "id,name,currency,timezone_name,account_status",
    limit: "100",
    access_token: accessToken,
  });
  for (let i = 0; i < 20; i++) {
    for (const a of page.data ?? []) out.push({ accountId: metaAccountId(a.id), name: a.name ?? null, currency: a.currency ?? null, timezone: a.timezone_name ?? null });
    next = page.paging?.next ?? null;
    if (!next) break;
    page = await metaGet(c, next, {});
  }
  return out;
}

/** Spend, impressions, clicks, purchases and leads per campaign per day, from `since` to `until`. */
export async function metaCampaignDays(c: MetaConfig, accessToken: string, accountId: string, since: string, until: string): Promise<AdDayRow[]> {
  const out: AdDayRow[] = [];
  let page = await metaGet<{ data: MetaInsightRow[]; paging?: { next?: string } }>(c, `${metaAccountId(accountId)}/insights`, {
    level: "campaign",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values",
    limit: "500",
    access_token: accessToken,
  });
  for (let i = 0; i < 50; i++) {
    for (const r of page.data ?? []) out.push(fromMetaInsight(metaAccountId(accountId), r));
    const next = page.paging?.next;
    if (!next) break;
    page = await metaGet(c, next, {});
  }
  return out;
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Issued by Google to the Ads API project; sent on every Ads API call. */
  developerToken: string;
  /** Google Ads API version, e.g. "v25". */
  version: string;
  fetchImpl?: FetchLike;
}

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

export function googleAuthorizeUrl(c: GoogleConfig, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_ADS_SCOPE,
    // A refresh token, every time: the access token lasts an hour and syncs run for months.
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function googleToken(c: GoogleConfig, form: Record<string, string>): Promise<{ access_token: string; expires_in?: number; refresh_token?: string }> {
  const res = await (c.fetchImpl ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...form }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
  if (res.ok && body.access_token) return body as { access_token: string; expires_in?: number; refresh_token?: string };
  const msg = body.error_description ?? body.error ?? `Google returned ${res.status}`;
  if (body.error === "invalid_grant" || res.status === 401) throw new AdsAuthError(msg);
  if (res.status === 429 || res.status >= 500) throw new AdsRetryableError(msg);
  throw new AdsApiError(msg, res.status);
}

export async function googleExchangeCode(c: GoogleConfig, code: string, redirectUri: string): Promise<TokenSet> {
  const t = await googleToken(c, { code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: expiry(t.expires_in) };
}

/** A fresh one-hour access token from the stored refresh token. */
export async function googleRefresh(c: GoogleConfig, refreshToken: string): Promise<TokenSet> {
  const t = await googleToken(c, { refresh_token: refreshToken, grant_type: "refresh_token" });
  return { accessToken: t.access_token, refreshToken, expiresAt: expiry(t.expires_in) };
}

async function googleAds<T>(c: GoogleConfig, accessToken: string, path: string, init: { method: "GET" | "POST"; body?: unknown; loginCustomerId?: string | null }): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}`, "developer-token": c.developerToken };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.loginCustomerId) headers["login-customer-id"] = googleCustomerId(init.loginCustomerId);
  const res = await (c.fetchImpl ?? fetch)(`https://googleads.googleapis.com/${c.version}/${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string; details?: unknown } };
  const err = Array.isArray(body) ? (body[0] as { error?: { message?: string; status?: string } })?.error : (body as { error?: { message?: string; status?: string } }).error;
  if (res.ok && !err) return body;
  const msg = err?.message ?? `Google Ads returned ${res.status}`;
  if (res.status === 401 || err?.status === "UNAUTHENTICATED") throw new AdsAuthError(msg);
  if (res.status === 429 || res.status >= 500 || err?.status === "RESOURCE_EXHAUSTED" || err?.status === "UNAVAILABLE") throw new AdsRetryableError(msg);
  throw new AdsApiError(msg, res.status);
}

type SearchStream<R> = Array<{ results?: R[] }>;

async function googleSearch<R>(c: GoogleConfig, accessToken: string, customerId: string, query: string, loginCustomerId?: string | null): Promise<R[]> {
  const batches = await googleAds<SearchStream<R>>(c, accessToken, `customers/${googleCustomerId(customerId)}/googleAds:searchStream`, { method: "POST", body: { query }, loginCustomerId });
  return batches.flatMap((b) => b.results ?? []);
}

interface CustomerRow {
  customer?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean };
}
interface CustomerClientRow {
  customerClient?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean; status?: string };
}

/**
 * Every ad account the person can report on: the ones they reach directly, and the clients of
 * any manager account they reach (which need the manager's id on every call).
 */
export async function googleAdAccounts(c: GoogleConfig, accessToken: string): Promise<AdAccount[]> {
  const list = await googleAds<{ resourceNames?: string[] }>(c, accessToken, "customers:listAccessibleCustomers", { method: "GET" });
  const ids = (list.resourceNames ?? []).map((r) => r.split("/").pop()!).filter(Boolean);
  const out = new Map<string, AdAccount>();
  for (const id of ids) {
    let me: CustomerRow["customer"];
    try {
      me = (await googleSearch<CustomerRow>(c, accessToken, id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer"))[0]?.customer;
    } catch (err) {
      // A cancelled or suspended account in the list: skip it rather than fail the connection.
      if (err instanceof AdsApiError) continue;
      throw err;
    }
    if (!me) continue;
    if (!me.manager) {
      out.set(id, { accountId: id, name: me.descriptiveName ?? null, currency: me.currencyCode ?? null, timezone: me.timeZone ?? null, loginCustomerId: null });
      continue;
    }
    const clients = await googleSearch<CustomerClientRow>(
      c,
      accessToken,
      id,
      "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.manager = FALSE AND customer_client.status = 'ENABLED'",
      id,
    ).catch((err) => {
      if (err instanceof AdsApiError) return [] as CustomerClientRow[];
      throw err;
    });
    for (const cl of clients) {
      const cid = cl.customerClient?.id ? String(cl.customerClient.id) : null;
      if (!cid || out.has(cid)) continue;
      out.set(cid, { accountId: cid, name: cl.customerClient?.descriptiveName ?? null, currency: cl.customerClient?.currencyCode ?? null, timezone: cl.customerClient?.timeZone ?? null, loginCustomerId: id });
    }
  }
  return [...out.values()];
}

/** Cost, impressions, clicks, conversions and their value per campaign per day. */
export async function googleCampaignDays(c: GoogleConfig, accessToken: string, account: { accountId: string; loginCustomerId?: string | null }, since: string, until: string): Promise<AdDayRow[]> {
  // The days go into the query text: only ever real YYYY-MM-DD days.
  if (!isDay(since) || !isDay(until)) throw new AdsApiError(`Invalid date range ${since}..${until}`, 400);
  const rows = await googleSearch<GoogleAdsRow>(
    c,
    accessToken,
    account.accountId,
    `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`,
    account.loginCustomerId,
  );
  return rows.map((r) => fromGoogleAdsRow(googleCustomerId(account.accountId), r)).filter((r): r is AdDayRow => r !== null);
}

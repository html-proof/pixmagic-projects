/**
 * Meta Marketing API, Google Ads API and AdSense Management API clients: the OAuth handshake
 * ("Continue with Meta" / "Continue with Google Ads" / "Continue with Google AdSense"), the
 * accounts a person can see, and daily numbers per campaign (ads) or per site (AdSense).
 *
 * Read-only by design: the only permissions asked for are `ads_read` (Meta), the Google Ads scope
 * used for reporting and `adsense.readonly`. Nothing here creates, edits or pauses an ad.
 *
 * Every function takes its keys and a fetch implementation as arguments, so tests run against
 * fakes and nothing in here reads the environment.
 */
import {
  adsenseAccountId,
  fromAdsenseReport,
  fromGoogleAdsRow,
  fromMetaInsight,
  fromMetaRangeInsight,
  fromMetaBreakdownInsight,
  googleCustomerId,
  googleReportMetrics,
  googleReportRows,
  isDay,
  isMetaBreakdown,
  META_BREAKDOWN_PARAM,
  metaAccountId,
  metaReportMetrics,
  type AdDayRow,
  type AdsenseDayRow,
  type AdsenseReport,
  type GoogleAdsRow,
  type GoogleReportApiRow,
  type GoogleReportLevel,
  type GoogleReportMetrics,
  type GoogleReportRow,
  type MetaInsightRow,
  type MetaRangeInsight,
  type MetaReportBreakdown,
  type MetaReportLevel,
  type MetaReportMetrics,
  type MetaReportRow,
  type MetaReportView,
} from "@app/shared";
import type { FetchLike } from "./shopify.js";

/** The person's access was refused or has expired: they have to connect again. */
export class AdsAuthError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** The platform said no for a reason that a retry may fix (rate limits, outages). */
export class AdsRetryableError extends Error {
  constructor(
    message: string,
    /** The platform's own error code, when it gives one (Meta's `error.code`). */
    public code?: number,
  ) {
    super(message);
  }
}

/** Anything else the platform rejected (a bad request, an account we can't read). */
export class AdsApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** The platform's own error code, when it gives one (Meta's `error.code`). */
    public code?: number,
  ) {
    super(message);
  }
}

/**
 * Google hasn't approved Insights' Cloud project for real (production) Google Ads accounts yet: it has
 * Test access only. Nothing the merchant does fixes it, so it's never mistaken for "no accounts".
 */
export class AdsNotApprovedError extends AdsApiError {
  constructor(message: string) {
    super(message, 403);
  }
}

/**
 * Why a login gives nothing to connect: it reaches no ad account at all (Google's NOT_ADS_USER, or an
 * empty list), Google only: it reaches only manager accounts with no active ad account under them, or
 * the accounts it reaches can't be reported on (sign-up not finished, cancelled, suspended); Meta only:
 * the person picked which ad accounts to share on Facebook's screen and none of them came through.
 */
export type NoAdAccountsReason = "no_ads_account" | "manager_only" | "not_ready" | "none_shared";

/** The login has no ad account Insights can report on; `reason` says which case it is. */
export class AdsNoAccountsError extends AdsApiError {
  constructor(
    message: string,
    public reason: NoAdAccountsReason = "no_ads_account",
  ) {
    super(message, 403);
  }
}

/** Meta's "permission" errors: 10 and 200-299. Either the app lost ads_read, or this login lost the account. */
export const isMetaPermissionError = (err: unknown) => err instanceof AdsApiError && err.code !== undefined && (err.code === 10 || (err.code >= 200 && err.code <= 299));

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
  /**
   * The permissions the person actually granted, when the platform says (Google lists them with
   * the token; Meta answers /me/permissions). People can untick a permission on the consent screen.
   */
  grantedScopes?: string[];
}

/** The one permission each platform needs. Nothing else is asked for. */
export const REQUIRED_AD_SCOPE = {
  meta: "ads_read",
  google: "https://www.googleapis.com/auth/adwords",
  adsense: "https://www.googleapis.com/auth/adsense.readonly",
} as const;

const expiry = (seconds: unknown) => (typeof seconds === "number" && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null);

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export interface MetaConfig {
  appId: string;
  appSecret: string;
  /** Graph / Marketing API version, e.g. "v25.0". */
  version: string;
  /**
   * Facebook Login for Business: the Login Configuration made in the app dashboard (user access
   * token, ads_read). Meta recommends it over `scope`; without one, classic Facebook Login's
   * `scope` is used.
   */
  configId?: string;
  fetchImpl?: FetchLike;
}

export const META_SCOPES: string[] = [REQUIRED_AD_SCOPE.meta];

export function metaAuthorizeUrl(c: MetaConfig, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: c.appId, redirect_uri: redirectUri, state, response_type: "code" });
  if (c.configId) {
    q.set("config_id", c.configId);
  } else {
    q.set("scope", META_SCOPES.join(","));
    // Ask again for a permission the person declined last time (Meta won't re-show it otherwise).
    q.set("auth_type", "rerequest");
  }
  return `https://www.facebook.com/${c.version}/dialog/oauth?${q}`;
}

async function metaGet<T>(c: MetaConfig, path: string, params: Record<string, string>): Promise<T> {
  // A full URL is Meta's own `paging.next`, which carries the access token: only ever to Graph.
  if (path.startsWith("https://") && new URL(path).hostname !== "graph.facebook.com") {
    throw new AdsApiError("Meta returned a page link outside graph.facebook.com", 502);
  }
  const url = path.startsWith("https://") ? path : `https://graph.facebook.com/${c.version}/${path}?${new URLSearchParams(params)}`;
  return metaCall<T>(c, url, { method: "GET" });
}

/** POST and DELETE: the parameters go in the form body, so the token never sits in a URL. */
async function metaSend<T>(c: MetaConfig, method: "POST" | "DELETE", path: string, params: Record<string, string>): Promise<T> {
  return metaCall<T>(c, `https://graph.facebook.com/${c.version}/${path}`, {
    method,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

async function metaCall<T>(c: MetaConfig, url: string, init: RequestInit): Promise<T> {
  const res = await (c.fetchImpl ?? fetch)(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number; error_subcode?: number } };
  if (res.ok && !body.error) return body;
  const e = body.error ?? {};
  const msg = e.message ?? `Meta returned ${res.status}`;
  // 190: the token is invalid or expired; 102: session expired. Both need the person to connect again.
  // 10/200-299 (permission) are API errors with their code: reconnecting only helps if ads_read itself
  // was taken back, which the sync checks (adConnections.ts); a login that lost one account can't fix it.
  const code = e.code ?? 0;
  if (code === 190 || code === 102 || res.status === 401) throw new AdsAuthError(msg);
  // 4, 17, 32, 613, 80000-80014: rate limits; 1/2: temporary.
  if ([1, 2, 4, 17, 32, 613].includes(e.code ?? 0) || (e.code ?? 0) >= 80000 || res.status === 429 || res.status >= 500) throw new AdsRetryableError(msg, e.code);
  throw new AdsApiError(msg, res.status, e.code);
}

/** The code from the redirect → a long-lived (about 60 days) user token. */
/**
 * The code from the redirect → a token that lasts. A user token is swapped for a long-lived one
 * (about 60 days). A Facebook Login for Business system-user token comes back without an expiry
 * (it never expires) and isn't swapped: Meta only documents that swap for expiring tokens.
 */
export async function metaExchangeCode(c: MetaConfig, code: string, redirectUri: string): Promise<TokenSet> {
  const first = await metaGet<{ access_token: string; expires_in?: number }>(c, "oauth/access_token", { client_id: c.appId, client_secret: c.appSecret, redirect_uri: redirectUri, code });
  if (!first.expires_in) return { accessToken: first.access_token, refreshToken: null, expiresAt: null };
  const long = await metaGet<{ access_token: string; expires_in?: number }>(c, "oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: c.appId,
    client_secret: c.appSecret,
    fb_exchange_token: first.access_token,
  });
  return { accessToken: long.access_token, refreshToken: null, expiresAt: expiry(long.expires_in) };
}

/** The permissions the person granted this app (a declined one is listed as "declined"). */
export async function metaGrantedPermissions(c: MetaConfig, accessToken: string): Promise<string[]> {
  const res = await metaGet<{ data?: Array<{ permission: string; status: string }> }>(c, "me/permissions", { access_token: accessToken });
  return (res.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
}

/** The person's app-scoped Meta user id, so connections that share their grant can be told apart from others. */
export async function metaUserId(c: MetaConfig, accessToken: string): Promise<string | null> {
  const me = await metaGet<{ id?: string }>(c, "me", { fields: "id", access_token: accessToken });
  return me.id && /^\d{1,30}$/.test(me.id) ? me.id : null;
}

/**
 * Take back ads_read only: anything else the person gave Insights' Meta app (WhatsApp) stays. A token
 * that already stopped working has nothing left to take back.
 */
export async function metaRevokeAdsRead(c: MetaConfig, accessToken: string): Promise<void> {
  try {
    await metaSend(c, "DELETE", "me/permissions/ads_read", { access_token: accessToken });
  } catch (err) {
    if (err instanceof AdsAuthError) return;
    throw err;
  }
}

/**
 * The ad accounts a person's Meta grant names, from Meta's token inspector (asked with Insights' app
 * token, as Meta requires): null when ads_read covers every account the login reaches (Meta then names
 * none), a list (maybe empty) when the person picked accounts on Facebook's screen.
 */
export async function metaAdsReadTargets(c: MetaConfig, accessToken: string): Promise<string[] | null> {
  const r = await metaGet<{ data?: { granular_scopes?: Array<{ scope?: string; target_ids?: string[] }> } }>(c, "debug_token", {
    input_token: accessToken,
    access_token: `${c.appId}|${c.appSecret}`,
  });
  return (r.data?.granular_scopes ?? []).find((g) => g.scope === REQUIRED_AD_SCOPE.meta)?.target_ids ?? null;
}

/**
 * Ad accounts the person can read. Never empty: with nothing to connect it throws AdsNoAccountsError,
 * saying whether the login reaches no ad account or the person shared none on Facebook's screen.
 */
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
  if (out.length) return out;
  // Only explains the empty list: a failed look-up still ends in "no ad account".
  const targets = await metaAdsReadTargets(c, accessToken).catch(() => null);
  if (targets) throw new AdsNoAccountsError(`The ads_read grant names ${targets.length ? targets.join(", ") : "no ad account"} and none can be read`, "none_shared");
  throw new AdsNoAccountsError("This Facebook login reaches no ad account");
}

/** Spend, impressions, clicks, purchases and leads per campaign per day, from `since` to `until`. */
export async function metaCampaignDays(c: MetaConfig, accessToken: string, accountId: string, since: string, until: string, opts: { pollMs?: number } = {}): Promise<AdDayRow[]> {
  const params = {
    level: "campaign",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values",
    // Purchases credited by each ad set's own attribution setting, the way Ads Manager counts them.
    use_unified_attribution_setting: "true",
    limit: "500",
  };
  const act = metaAccountId(accountId);
  let page: { data: MetaInsightRow[]; paging?: { next?: string } };
  try {
    page = await metaGet(c, `${act}/insights`, { ...params, access_token: accessToken });
  } catch (err) {
    // Meta answers a big account's long range with a temporary error ("reduce the amount of data");
    // it wants those run as a report job instead.
    if (!(err instanceof AdsRetryableError) || (err.code !== 1 && err.code !== 2)) throw err;
    return (await metaInsightsJob(c, accessToken, act, params, opts.pollMs)).map((r) => fromMetaInsight(act, r));
  }
  const out: AdDayRow[] = [];
  for (let i = 0; i < 50; i++) {
    for (const r of page.data ?? []) out.push(fromMetaInsight(act, r));
    const next = page.paging?.next;
    if (!next) break;
    page = await metaGet(c, next, {});
  }
  return out;
}

/**
 * An asynchronous Insights report: start the job, wait for it (about 8 minutes at most), then read
 * its pages. A job that's still running then is a temporary failure, so the queue tries again later.
 */
export async function metaInsightsJob(c: MetaConfig, accessToken: string, act: string, params: Record<string, string>, pollMs = 5000): Promise<MetaInsightRow[]> {
  const { limit: pageSize = "500", ...jobParams } = params;
  const job = await metaSend<{ report_run_id?: string }>(c, "POST", `${act}/insights`, { ...jobParams, access_token: accessToken });
  const id = job.report_run_id;
  if (!id || !/^\d{1,30}$/.test(id)) throw new AdsApiError("Meta didn't start the report", 502);
  for (let i = 0; ; i++) {
    const s = await metaGet<{ async_status?: string; async_percent_completion?: number }>(c, id, { fields: "async_status,async_percent_completion", access_token: accessToken });
    if (s.async_status === "Job Completed") break;
    if (s.async_status === "Job Failed" || s.async_status === "Job Skipped") throw new AdsRetryableError(`Meta's report job ended: ${s.async_status}`);
    // About 8 minutes: a queue consumer may run for 15, and a retry would only start the job again.
    if (i >= 96) throw new AdsRetryableError("Meta's report is taking longer than usual");
    if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));
  }
  const out: MetaInsightRow[] = [];
  let page = await metaGet<{ data: MetaInsightRow[]; paging?: { next?: string } }>(c, `${id}/insights`, { limit: pageSize, access_token: accessToken });
  for (let i = 0; i < 100; i++) {
    out.push(...(page.data ?? []));
    const next = page.paging?.next;
    if (!next) break;
    page = await metaGet(c, next, {});
  }
  return out;
}

const RANGE_FIELDS = "spend,impressions,reach,frequency,clicks,inline_link_clicks,actions,action_values";
const LEVEL_FIELDS: Record<MetaReportLevel, string> = {
  campaign: "campaign_id,campaign_name",
  adset: "campaign_name,adset_id,adset_name,attribution_setting",
  ad: "campaign_name,adset_name,ad_id,ad_name,attribution_setting",
};

/**
 * Totals for one whole range, for the account or per campaign / ad set / ad. Results follow each
 * ad set's own attribution setting, as Ads Manager shows them.
 */
export async function metaRangeInsights(
  c: MetaConfig,
  accessToken: string,
  accountId: string,
  level: "account" | MetaReportLevel,
  since: string,
  until: string,
  maxRows = 2000,
  /** Split the account's numbers by placement, device or country (level "account" only). */
  breakdown?: MetaReportBreakdown,
): Promise<MetaRangeInsight[]> {
  if (!isDay(since) || !isDay(until)) throw new AdsApiError(`Invalid date range ${since}..${until}`, 400);
  const out: MetaRangeInsight[] = [];
  let page = await metaGet<{ data: MetaRangeInsight[]; paging?: { next?: string } }>(c, `${metaAccountId(accountId)}/insights`, {
    level,
    time_range: JSON.stringify({ since, until }),
    fields: level === "account" ? RANGE_FIELDS : `${LEVEL_FIELDS[level]},${RANGE_FIELDS}`,
    ...(breakdown && level === "account" ? { breakdowns: META_BREAKDOWN_PARAM[breakdown] } : {}),
    use_unified_attribution_setting: "true",
    limit: "500",
    access_token: accessToken,
  });
  for (let i = 0; i < 20; i++) {
    out.push(...(page.data ?? []));
    const next = page.paging?.next;
    if (!next || out.length >= maxRows) break;
    page = await metaGet(c, next, {});
  }
  return out;
}

/** effective_status per campaign / ad set / ad id (ACTIVE, PAUSED, CAMPAIGN_PAUSED, WITH_ISSUES...). */
export async function metaStatuses(c: MetaConfig, accessToken: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const valid = [...new Set(ids)].filter((id) => /^\d{1,30}$/.test(id));
  for (let i = 0; i < valid.length; i += 50) {
    const res = await metaGet<Record<string, { id?: string; effective_status?: string }>>(c, "", {
      ids: valid.slice(i, i + 50).join(","),
      fields: "effective_status",
      access_token: accessToken,
    });
    for (const [id, v] of Object.entries(res)) if (v?.effective_status) out.set(id, v.effective_status);
  }
  return out;
}

export interface MetaReport {
  level: MetaReportView;
  since: string;
  until: string;
  /** The account's own totals: reach and frequency count each person once over the whole range. */
  totals: MetaReportMetrics;
  /** Biggest spend first. */
  rows: MetaReportRow[];
  /** More rows had spend than are listed. */
  truncated: boolean;
  /** The attribution settings the rows were reported with. */
  attribution: string[];
}

/** By campaign, ad set or ad (with each one's delivery status), or the whole account split by placement, device or country. */
export async function metaReport(c: MetaConfig, accessToken: string, accountId: string, level: MetaReportView, since: string, until: string, maxRows = 200): Promise<MetaReport> {
  const breakdown = isMetaBreakdown(level) ? level : null;
  const [account, raw] = await Promise.all([
    metaRangeInsights(c, accessToken, accountId, "account", since, until),
    breakdown ? metaRangeInsights(c, accessToken, accountId, "account", since, until, 2000, breakdown) : metaRangeInsights(c, accessToken, accountId, level as MetaReportLevel, since, until),
  ]);
  const all = raw
    .map((r) => (breakdown ? fromMetaBreakdownInsight(breakdown, r) : fromMetaRangeInsight(level as MetaReportLevel, r)))
    .sort((a, b) => b.spend - a.spend || b.impressions - a.impressions);
  const rows = all.slice(0, maxRows);
  if (!breakdown) {
    // A status that can't be read (an ad deleted since) leaves the row's status unknown, not the report broken.
    const statuses = await metaStatuses(c, accessToken, rows.map((r) => r.id)).catch((err: unknown) => {
      if (err instanceof AdsApiError) return new Map<string, string>();
      throw err;
    });
    for (const r of rows) r.status = statuses.get(r.id) ?? null;
  }
  return {
    level,
    since,
    until,
    // No row at all: nothing was shown in the range, so nobody was reached.
    totals: metaReportMetrics(account[0] ?? { reach: "0" }),
    rows,
    truncated: all.length > rows.length,
    attribution: [...new Set(all.map((r) => r.attribution).filter((a): a is string => !!a))],
  };
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

/** A Google Cloud OAuth client. Google Ads and AdSense both sign in through the same one. */
export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
}

/**
 * Google Ads API access follows the Cloud project that owns the OAuth client (Google retired developer
 * tokens on 2026-09-09), so the client and an API version are all a call needs.
 */
export interface GoogleConfig extends GoogleOAuthClient {
  /** Google Ads API version, e.g. "v25". */
  version: string;
}

export const GOOGLE_ADS_SCOPE = REQUIRED_AD_SCOPE.google;

/**
 * Google's consent screen. `codeChallenge` is the PKCE S256 challenge: its verifier stays on the
 * server and goes with the code exchange.
 */
function googleConsentUrl(c: GoogleOAuthClient, scope: string, redirectUri: string, state: string, codeChallenge?: string): string {
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    // A refresh token, every time: the access token lasts an hour and syncs run for months.
    access_type: "offline",
    // Google's account chooser, every time: otherwise a browser signed in to one Google account goes
    // straight through with it, and someone whose ads live under another login can never pick that one.
    prompt: "select_account consent",
    state,
  });
  if (codeChallenge) {
    q.set("code_challenge", codeChallenge);
    q.set("code_challenge_method", "S256");
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export function googleAuthorizeUrl(c: GoogleConfig, redirectUri: string, state: string, codeChallenge?: string): string {
  return googleConsentUrl(c, GOOGLE_ADS_SCOPE, redirectUri, state, codeChallenge);
}

async function googleToken(c: GoogleOAuthClient, form: Record<string, string>): Promise<{ access_token: string; expires_in?: number; refresh_token?: string; scope?: string }> {
  const res = await (c.fetchImpl ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...form }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (res.ok && body.access_token) return body as { access_token: string; expires_in?: number; refresh_token?: string; scope?: string };
  const msg = body.error_description ?? body.error ?? `Google returned ${res.status}`;
  if (body.error === "invalid_grant" || res.status === 401) throw new AdsAuthError(msg);
  if (res.status === 429 || res.status >= 500) throw new AdsRetryableError(msg);
  throw new AdsApiError(msg, res.status);
}

export async function googleExchangeCode(c: GoogleOAuthClient, code: string, redirectUri: string, codeVerifier?: string): Promise<TokenSet> {
  const t = await googleToken(c, { code, redirect_uri: redirectUri, grant_type: "authorization_code", ...(codeVerifier ? { code_verifier: codeVerifier } : {}) });
  // Google lists what was granted, space-separated; with granular consent a scope can be left unticked.
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: expiry(t.expires_in), grantedScopes: t.scope ? t.scope.split(/\s+/).filter(Boolean) : undefined };
}

/**
 * A fresh one-hour access token from the stored refresh token. If Google hands back a new refresh
 * token with it, that one replaces the old (`rotated`), so the caller must store it.
 */
export async function googleRefresh(c: GoogleOAuthClient, refreshToken: string): Promise<TokenSet & { rotated: boolean }> {
  const t = await googleToken(c, { refresh_token: refreshToken, grant_type: "refresh_token" });
  const next = t.refresh_token && t.refresh_token !== refreshToken ? t.refresh_token : refreshToken;
  return { accessToken: t.access_token, refreshToken: next, expiresAt: expiry(t.expires_in), rotated: next !== refreshToken };
}

/**
 * Take back the access a person gave Insights' Google client. Google ends that person's whole grant
 * to the client (Google Ads and AdSense alike), so callers only do this when nothing else relies on it.
 * A token Google already considers dead counts as revoked.
 */
export async function googleRevoke(c: Pick<GoogleOAuthClient, "fetchImpl">, token: string): Promise<void> {
  const res = await (c.fetchImpl ?? fetch)("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
  if (body.error === "invalid_token") return;
  const msg = body.error_description ?? body.error ?? `Google returned ${res.status}`;
  if (res.status === 429 || res.status >= 500) throw new AdsRetryableError(msg);
  throw new AdsApiError(msg, res.status);
}

/**
 * The Google account behind an access token (`sub`), checked to be a token issued to Insights'
 * own client. Null when Google doesn't say: the connection still works, it just can't share a grant.
 */
export async function googleUserId(c: GoogleOAuthClient, accessToken: string): Promise<string | null> {
  const res = await (c.fetchImpl ?? fetch)(`https://oauth2.googleapis.com/tokeninfo?${new URLSearchParams({ access_token: accessToken })}`, { method: "GET" });
  const body = (await res.json().catch(() => ({}))) as { sub?: string; aud?: string; azp?: string; error?: string; error_description?: string };
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) throw new AdsAuthError(body.error_description ?? "Google didn't recognise the access token");
    throw new AdsRetryableError(`Google returned ${res.status}`);
  }
  if ((body.aud ?? body.azp) !== c.clientId) throw new AdsAuthError("The Google token was issued to another app");
  return body.sub && /^\d{1,40}$/.test(body.sub) ? body.sub : null;
}

async function googleAds<T>(c: GoogleConfig, accessToken: string, path: string, init: { method: "GET" | "POST"; body?: unknown; loginCustomerId?: string | null }): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.loginCustomerId) headers["login-customer-id"] = googleCustomerId(init.loginCustomerId);
  const res = await (c.fetchImpl ?? fetch)(`https://googleads.googleapis.com/${c.version}/${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  type GoogleError = { message?: string; status?: string; details?: unknown };
  const body = (await res.json().catch(() => ({}))) as T & { error?: GoogleError };
  const err = Array.isArray(body) ? (body[0] as { error?: GoogleError })?.error : (body as { error?: GoogleError }).error;
  if (res.ok && !err) return body;
  const msg = err?.message ?? `Google Ads returned ${res.status}`;
  // A Google login with no Google Ads account answers NOT_ADS_USER: that's "no accounts", not ended access.
  if (/NOT_ADS_USER/.test(JSON.stringify(err?.details ?? ""))) throw new AdsNoAccountsError(msg);
  if (res.status === 401 || err?.status === "UNAUTHENTICATED") throw new AdsAuthError(msg);
  // The project's access level doesn't cover production accounts (CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION
  // and its kin): Insights' own approval, not the merchant's account.
  if (/NOT_APPROVED/.test(JSON.stringify(err?.details ?? "")) || /not approved for production/i.test(msg)) throw new AdsNotApprovedError(msg);
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
 * any manager account they reach (which need the manager's id on every call). Never empty: with
 * nothing to connect it throws AdsNoAccountsError, saying why, so the person is told what to do.
 */
export async function googleAdAccounts(c: GoogleConfig, accessToken: string): Promise<AdAccount[]> {
  const list = await googleAds<{ resourceNames?: string[] }>(c, accessToken, "customers:listAccessibleCustomers", { method: "GET" });
  const ids = (list.resourceNames ?? []).map((r) => r.split("/").pop()!).filter(Boolean);
  if (!ids.length) throw new AdsNoAccountsError("This Google login has no Google Ads account");
  const out = new Map<string, AdAccount>();
  const unreadable: string[] = [];
  for (const id of ids) {
    let me: CustomerRow["customer"];
    try {
      me = (await googleSearch<CustomerRow>(c, accessToken, id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer"))[0]?.customer;
    } catch (err) {
      // A cancelled, suspended or half-set-up account in the list: skip it rather than fail the connection.
      if (err instanceof AdsApiError && !(err instanceof AdsNotApprovedError)) {
        unreadable.push(`${id}: ${err.message}`);
        continue;
      }
      throw err;
    }
    if (!me) {
      unreadable.push(`${id}: no account details`);
      continue;
    }
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
      if (err instanceof AdsApiError && !(err instanceof AdsNotApprovedError)) return [] as CustomerClientRow[];
      throw err;
    });
    for (const cl of clients) {
      const cid = cl.customerClient?.id ? String(cl.customerClient.id) : null;
      if (!cid || out.has(cid)) continue;
      out.set(cid, { accountId: cid, name: cl.customerClient?.descriptiveName ?? null, currency: cl.customerClient?.currencyCode ?? null, timezone: cl.customerClient?.timeZone ?? null, loginCustomerId: id });
    }
  }
  if (out.size) return [...out.values()];
  // Accounts exist but none can be read: unfinished or closed accounts first, since they're the person's own.
  if (unreadable.length) throw new AdsNoAccountsError(`Google Ads won't report on ${unreadable.join("; ")}`, "not_ready");
  throw new AdsNoAccountsError(`Only manager accounts with no active ad account under them: ${ids.join(", ")}`, "manager_only");
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

export interface GoogleReport {
  level: GoogleReportLevel;
  since: string;
  until: string;
  /** The whole account's totals for the range. */
  totals: GoogleReportMetrics;
  /** Biggest spend first. */
  rows: GoogleReportRow[];
  /** More rows had spend than are listed. */
  truncated: boolean;
}

const GOOGLE_METRICS = "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value";

/** The query for each level. Without segments.date in SELECT, Google sums the metrics over the range. */
function googleReportQuery(level: GoogleReportLevel, since: string, until: string): string {
  const during = `segments.date BETWEEN '${since}' AND '${until}'`;
  switch (level) {
    case "campaign":
      return `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, ${GOOGLE_METRICS} FROM campaign WHERE ${during}`;
    case "ad_group":
      return `SELECT campaign.name, ad_group.id, ad_group.name, ad_group.status, ${GOOGLE_METRICS} FROM ad_group WHERE ${during}`;
    case "device":
      return `SELECT segments.device, ${GOOGLE_METRICS} FROM customer WHERE ${during}`;
    case "country":
      // Where the people who saw the ads were (not the places targeted).
      return `SELECT user_location_view.country_criterion_id, ${GOOGLE_METRICS} FROM user_location_view WHERE ${during}`;
  }
}

/** Geo target ids (2840) → ISO country codes (US), so countries can be named. */
async function googleCountryCodes(c: GoogleConfig, accessToken: string, account: { accountId: string; loginCustomerId?: string | null }, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const valid = [...new Set(ids)].filter((id) => /^\d{1,12}$/.test(id));
  for (let i = 0; i < valid.length; i += 200) {
    const names = valid.slice(i, i + 200).map((id) => `'geoTargetConstants/${id}'`).join(", ");
    const rows = await googleSearch<{ geoTargetConstant?: { id?: string | number; countryCode?: string } }>(
      c,
      accessToken,
      account.accountId,
      `SELECT geo_target_constant.id, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${names})`,
      account.loginCustomerId,
    );
    for (const r of rows) if (r.geoTargetConstant?.id && r.geoTargetConstant.countryCode) out.set(String(r.geoTargetConstant.id), r.geoTargetConstant.countryCode);
  }
  return out;
}

/**
 * The Google Ads report for one account and range, by campaign, ad group, device or country, plus
 * the account's own totals. Read-only GAQL; dates are validated before they go into the query.
 */
export async function googleReport(
  c: GoogleConfig,
  accessToken: string,
  account: { accountId: string; loginCustomerId?: string | null },
  level: GoogleReportLevel,
  since: string,
  until: string,
  maxRows = 200,
): Promise<GoogleReport> {
  if (!isDay(since) || !isDay(until)) throw new AdsApiError(`Invalid date range ${since}..${until}`, 400);
  const [totalRows, raw] = await Promise.all([
    googleSearch<GoogleReportApiRow>(c, accessToken, account.accountId, `SELECT ${GOOGLE_METRICS} FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`, account.loginCustomerId),
    googleSearch<GoogleReportApiRow>(c, accessToken, account.accountId, googleReportQuery(level, since, until), account.loginCustomerId),
  ]);
  let countries = new Map<string, string>();
  if (level === "country") {
    // A name that can't be looked up leaves the row as "Location <id>", not the report broken.
    countries = await googleCountryCodes(c, accessToken, account, raw.map((r) => String(r.userLocationView?.countryCriterionId ?? ""))).catch((err: unknown) => {
      if (err instanceof AdsApiError) return new Map<string, string>();
      throw err;
    });
  }
  const all = googleReportRows(level, raw, countries);
  const rows = all.slice(0, maxRows);
  const totals = googleReportRows("device", totalRows.map((r) => ({ ...r, segments: { device: "ALL" } })))[0];
  return { level, since, until, totals: totals ?? googleReportMetrics({}), rows, truncated: all.length > rows.length };
}

// ---------------------------------------------------------------------------
// AdSense (what the site earns from Google ads shown on it)
// ---------------------------------------------------------------------------

/** AdSense needs only the Google OAuth client (and the AdSense Management API on its project). */
export type AdsenseConfig = GoogleOAuthClient;

export const ADSENSE_SCOPE = REQUIRED_AD_SCOPE.adsense;

export function adsenseAuthorizeUrl(c: AdsenseConfig, redirectUri: string, state: string, codeChallenge?: string): string {
  return googleConsentUrl(c, ADSENSE_SCOPE, redirectUri, state, codeChallenge);
}

async function adsenseGet<T>(c: AdsenseConfig, accessToken: string, path: string, params: URLSearchParams): Promise<T> {
  const res = await (c.fetchImpl ?? fetch)(`https://adsense.googleapis.com/v2/${path}?${params}`, { method: "GET", headers: { authorization: `Bearer ${accessToken}` } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
  if (res.ok && !body.error) return body;
  const err = body.error ?? {};
  const msg = err.message ?? `AdSense returned ${res.status}`;
  if (res.status === 401 || err.status === "UNAUTHENTICATED") throw new AdsAuthError(msg);
  if (res.status === 429 || res.status >= 500 || err.status === "RESOURCE_EXHAUSTED" || err.status === "UNAVAILABLE") throw new AdsRetryableError(msg);
  throw new AdsApiError(msg, res.status);
}

interface AdsenseAccount {
  name?: string;
  displayName?: string;
  timeZone?: { id?: string };
  state?: string;
}

/**
 * The AdSense accounts the person can read; closed ones are left out. The account doesn't say
 * its currency: the first report does, and the sync stores it then.
 */
export async function adsenseAccounts(c: AdsenseConfig, accessToken: string): Promise<AdAccount[]> {
  const out: AdAccount[] = [];
  let pageToken = "";
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ pageSize: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const page = await adsenseGet<{ accounts?: AdsenseAccount[]; nextPageToken?: string }>(c, accessToken, "accounts", q);
    for (const a of page.accounts ?? []) {
      if (!a.name || a.state === "CLOSED") continue;
      out.push({ accountId: adsenseAccountId(a.name), name: a.displayName ?? null, currency: null, timezone: a.timeZone?.id ?? null });
    }
    pageToken = page.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return out;
}

/** Google spells a date in a query as three fields: startDate.year=2026&startDate.month=10&startDate.day=1. */
const dateParams = (prefix: string, day: string): Array<[string, string]> => {
  const [y, m, d] = day.split("-").map(Number);
  return [[`${prefix}.year`, String(y)], [`${prefix}.month`, String(m)], [`${prefix}.day`, String(d)]];
};

/**
 * Earnings, page views, ads shown and clicks per site per day, from `since` to `until`, on the
 * account's own calendar. Asked for by site; if AdSense won't split this account's report that
 * way, the account's daily totals are fetched instead (site "").
 */
export async function adsenseSiteDays(c: AdsenseConfig, accessToken: string, accountId: string, since: string, until: string): Promise<{ rows: AdsenseDayRow[]; currency: string | null }> {
  if (!isDay(since) || !isDay(until)) throw new AdsApiError(`Invalid date range ${since}..${until}`, 400);
  const pub = adsenseAccountId(accountId);
  // The id goes into the URL path: only ever a publisher id.
  if (!/^pub-\d+$/.test(pub)) throw new AdsApiError(`Invalid AdSense account ${accountId}`, 400);
  const query = (bySite: boolean) =>
    new URLSearchParams([
      ["dateRange", "CUSTOM"],
      ...dateParams("startDate", since),
      ...dateParams("endDate", until),
      ["dimensions", "DATE"],
      ...(bySite ? [["dimensions", "DOMAIN_CODE"] as [string, string]] : []),
      ["metrics", "ESTIMATED_EARNINGS"],
      ["metrics", "PAGE_VIEWS"],
      ["metrics", "IMPRESSIONS"],
      ["metrics", "CLICKS"],
      ["reportingTimeZone", "ACCOUNT_TIME_ZONE"],
      ["limit", "100000"],
    ]);
  const path = `accounts/${pub}/reports:generate`;
  let report: AdsenseReport;
  try {
    report = await adsenseGet<AdsenseReport>(c, accessToken, path, query(true));
  } catch (err) {
    if (!(err instanceof AdsApiError) || err.status !== 400) throw err;
    report = await adsenseGet<AdsenseReport>(c, accessToken, path, query(false));
  }
  return fromAdsenseReport(pub, report);
}

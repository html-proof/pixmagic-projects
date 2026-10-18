/**
 * Meta Marketing API: "Continue with Meta" (Facebook Login, ads_read only), the ad accounts a person
 * can read, daily numbers per campaign and the report by campaign, ad set, ad or breakdown. Every
 * call goes through the shared Graph API transport (metaGraph.ts).
 */
import {
  fromMetaBreakdownInsight,
  fromMetaInsight,
  fromMetaRangeInsight,
  isDay,
  isMetaBreakdown,
  META_BREAKDOWN_PARAM,
  metaAccountId,
  metaReportMetrics,
  type AdDayRow,
  type MetaInsightRow,
  type MetaRangeInsight,
  type MetaReportBreakdown,
  type MetaReportLevel,
  type MetaReportMetrics,
  type MetaReportRow,
  type MetaReportView,
} from "@app/shared";
import { graphCall, type GraphFailure } from "../metaGraph.js";
import type { FetchLike } from "../shopify.js";
import { AdsApiError, AdsAuthError, AdsNoAccountsError, AdsRetryableError, REQUIRED_AD_SCOPE, tokenExpiry, type AdAccount, type TokenSet } from "./common.js";

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

/** A Graph API failure as the ads code sorts it: connect again, try later, or give up. */
function metaAdsError(f: GraphFailure): Error {
  // Nothing answered: Meta or the network is down. The queue tries again; the API says "busy".
  if (f.reason === "network") return new AdsRetryableError(`Meta didn't answer: ${f.message}`);
  const msg = f.message ?? `Meta returned ${f.status}`;
  if (f.reason === "bad_link") return new AdsApiError(msg, 502);
  const code = f.code ?? undefined;
  // 190: the token is invalid or expired; 102: session expired. Both need the person to connect again.
  // 10/200-299 (permission) are API errors with their code: reconnecting only helps if ads_read itself
  // was taken back, which the sync checks (adConnections.ts); a login that lost one account can't fix it.
  if (code === 190 || code === 102 || f.status === 401) return new AdsAuthError(msg);
  // 4, 17, 32, 613, 80000-80014: rate limits; 1/2: temporary.
  if ([1, 2, 4, 17, 32, 613].includes(code ?? 0) || (code ?? 0) >= 80000 || f.status === 429 || f.status >= 500) return new AdsRetryableError(msg, code);
  return new AdsApiError(msg, f.status, code);
}

/** GET. `path` is relative to the API version, or a `paging.next` link Meta handed back. */
function metaGet<T>(c: MetaConfig, path: string, query: Record<string, string>, token?: string): Promise<T> {
  return graphCall<T>(c.fetchImpl ?? fetch, { version: c.version, method: "GET", path, query, token }, metaAdsError);
}

/** POST and DELETE: the parameters go in the form body. */
function metaSend<T>(c: MetaConfig, method: "POST" | "DELETE", path: string, form: Record<string, string>, token?: string): Promise<T> {
  return graphCall<T>(c.fetchImpl ?? fetch, { version: c.version, method, path, form, token }, metaAdsError);
}

/** bizinsights' own app token, which Meta wants for the token inspector (debug_token). */
const metaAppToken = (c: MetaConfig) => `${c.appId}|${c.appSecret}`;

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
  return { accessToken: long.access_token, refreshToken: null, expiresAt: tokenExpiry(long.expires_in) };
}

/** The permissions the person granted this app (a declined one is listed as "declined"). */
export async function metaGrantedPermissions(c: MetaConfig, accessToken: string): Promise<string[]> {
  const res = await metaGet<{ data?: Array<{ permission: string; status: string }> }>(c, "me/permissions", {}, accessToken);
  return (res.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
}

/** The person's app-scoped Meta user id, so connections that share their grant can be told apart from others. */
export async function metaUserId(c: MetaConfig, accessToken: string): Promise<string | null> {
  const me = await metaGet<{ id?: string }>(c, "me", { fields: "id" }, accessToken);
  return me.id && /^\d{1,30}$/.test(me.id) ? me.id : null;
}

/**
 * Take back ads_read only: anything else the person gave bizinsights' Meta app (WhatsApp) stays. A token
 * that already stopped working has nothing left to take back.
 */
export async function metaRevokeAdsRead(c: MetaConfig, accessToken: string): Promise<void> {
  try {
    await metaSend(c, "DELETE", "me/permissions/ads_read", {}, accessToken);
  } catch (err) {
    if (err instanceof AdsAuthError) return;
    throw err;
  }
}

/**
 * The ad accounts a person's Meta grant names, from Meta's token inspector (asked with bizinsights' app
 * token, as Meta requires): null when ads_read covers every account the login reaches (Meta then names
 * none), a list (maybe empty) when the person picked accounts on Facebook's screen.
 */
export async function metaAdsReadTargets(c: MetaConfig, accessToken: string): Promise<string[] | null> {
  const r = await metaGet<{ data?: { granular_scopes?: Array<{ scope?: string; target_ids?: string[] }> } }>(c, "debug_token", { input_token: accessToken }, metaAppToken(c));
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
  }, accessToken);
  for (let i = 0; i < 20; i++) {
    for (const a of page.data ?? []) out.push({ accountId: metaAccountId(a.id), name: a.name ?? null, currency: a.currency ?? null, timezone: a.timezone_name ?? null });
    next = page.paging?.next ?? null;
    if (!next) break;
    page = await metaGet(c, next, {}, accessToken);
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
    page = await metaGet(c, `${act}/insights`, params, accessToken);
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
    page = await metaGet(c, next, {}, accessToken);
  }
  return out;
}

/**
 * An asynchronous Insights report: start the job, wait for it (about 8 minutes at most), then read
 * its pages. A job that's still running then is a temporary failure, so the queue tries again later.
 */
export async function metaInsightsJob(c: MetaConfig, accessToken: string, act: string, params: Record<string, string>, pollMs = 5000): Promise<MetaInsightRow[]> {
  const { limit: pageSize = "500", ...jobParams } = params;
  const job = await metaSend<{ report_run_id?: string }>(c, "POST", `${act}/insights`, jobParams, accessToken);
  const id = job.report_run_id;
  if (!id || !/^\d{1,30}$/.test(id)) throw new AdsApiError("Meta didn't start the report", 502);
  for (let i = 0; ; i++) {
    const s = await metaGet<{ async_status?: string; async_percent_completion?: number }>(c, id, { fields: "async_status,async_percent_completion" }, accessToken);
    if (s.async_status === "Job Completed") break;
    if (s.async_status === "Job Failed" || s.async_status === "Job Skipped") throw new AdsRetryableError(`Meta's report job ended: ${s.async_status}`);
    // About 8 minutes: a queue consumer may run for 15, and a retry would only start the job again.
    if (i >= 96) throw new AdsRetryableError("Meta's report is taking longer than usual");
    if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));
  }
  const out: MetaInsightRow[] = [];
  let page = await metaGet<{ data: MetaInsightRow[]; paging?: { next?: string } }>(c, `${id}/insights`, { limit: pageSize }, accessToken);
  for (let i = 0; i < 100; i++) {
    out.push(...(page.data ?? []));
    const next = page.paging?.next;
    if (!next) break;
    page = await metaGet(c, next, {}, accessToken);
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
  }, accessToken);
  for (let i = 0; i < 20; i++) {
    out.push(...(page.data ?? []));
    const next = page.paging?.next;
    if (!next || out.length >= maxRows) break;
    page = await metaGet(c, next, {}, accessToken);
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
    }, accessToken);
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

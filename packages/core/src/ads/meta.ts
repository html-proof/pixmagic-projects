/**
 * Meta Marketing API: "Continue with Meta" (Facebook Login, ads_read only), the ad accounts a person
 * can read, daily numbers per campaign and the report by campaign, ad set, ad or breakdown. Every
 * call goes through the shared Graph API transport (metaGraph.ts).
 */
import {
  addDays,
  daysBetweenInclusive,
  fromMetaBreakdownInsight,
  fromMetaInsight,
  fromMetaRangeInsight,
  isDay,
  isMetaBreakdown,
  META_BREAKDOWN_PARAM,
  metaAccountId,
  metaAccountStatus,
  metaReportMetrics,
  type AdAccountStatus,
  type AdDayRow,
  type MetaInsightRow,
  type MetaRangeInsight,
  type MetaReportBreakdown,
  type MetaReportLevel,
  type MetaReportMetrics,
  type MetaReportRow,
  type MetaReportView,
} from "@app/shared";
import { logger } from "../logger.js";
import { graphCall, type GraphFailure } from "../metaGraph.js";
import type { FetchLike } from "../shopify.js";
import {
  adAccountList,
  AdsApiError,
  AdsAuthError,
  AdsNoAccountsError,
  AdsPermissionError,
  AdsRateLimitedError,
  AdsReportPendingError,
  AdsRetryableError,
  isMetaPermissionError,
  REQUIRED_AD_SCOPE,
  tokenExpiry,
  type AdAccount,
  type AdAccountHealth,
  type AdAccountList,
  type TokenSet,
} from "./common.js";

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

/**
 * Nothing answered at all (the network, or our own time limit on the call): Meta may still be working
 * on a heavy insights request, which it wants run as a report job instead.
 */
class MetaNoAnswerError extends AdsRetryableError {}

/**
 * How long Meta said to wait, in seconds, from its usage headers
 * (https://developers.facebook.com/docs/graph-api/overview/rate-limiting/):
 * X-Business-Use-Case-Usage `{"<id>": [{type, call_count, ..., estimated_time_to_regain_access}]}`
 * (minutes) and X-Ad-Account-Usage `{acc_id_util_pct, reset_time_duration, ...}` (seconds). The
 * longest wait wins; null when neither says.
 */
export function metaRetryAfterS(headers: Headers | null | undefined): number | null {
  const parse = (name: string): unknown => {
    try {
      const raw = headers?.get(name);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  let wait = 0;
  const buc = parse("x-business-use-case-usage");
  if (buc && typeof buc === "object") {
    for (const entries of Object.values(buc as Record<string, unknown>)) {
      for (const e of Array.isArray(entries) ? entries : []) {
        const minutes = Number((e as { estimated_time_to_regain_access?: unknown })?.estimated_time_to_regain_access);
        if (Number.isFinite(minutes) && minutes > 0) wait = Math.max(wait, minutes * 60);
      }
    }
  }
  const account = parse("x-ad-account-usage");
  const seconds = Number((account as { reset_time_duration?: unknown } | null)?.reset_time_duration);
  if (Number.isFinite(seconds) && seconds > 0) wait = Math.max(wait, seconds);
  return wait > 0 ? Math.ceil(wait) : null;
}

/** A Graph API failure as the ads code sorts it: connect again, try later, or give up. */
function metaAdsError(f: GraphFailure): Error {
  // Nothing answered: Meta or the network is down, or the call ran out of time. The queue tries again;
  // a heavy insights read becomes a report job instead (metaDailyRows). Meta's gateway timing out is the same.
  if (f.reason === "network") return new MetaNoAnswerError(`Meta didn't answer: ${f.message}`);
  if (f.status === 504 && f.code === null) return new MetaNoAnswerError(`Meta didn't answer in time (${f.status})`);
  const msg = f.message ?? `Meta returned ${f.status}`;
  if (f.reason === "bad_link") return new AdsApiError(msg, 502);
  const code = f.code ?? undefined;
  // 190: the token is invalid or expired; 102: session expired. Both need the person to connect again.
  if (code === 190 || code === 102 || f.status === 401) return new AdsAuthError(msg);
  // 10/200-299 (permission), and 100 with subcode 33 ("does not exist, cannot be loaded due to missing
  // permissions") on an ad account: this login can't read it. Reconnecting only helps if ads_read itself
  // was taken back, which metaClassifyPermissionError checks; the code is kept for it.
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299) || (code === 100 && f.subcode === 33)) return new AdsPermissionError(msg, code);
  // 4, 17, 32, 613, 80000-80014 (and HTTP 429): throttling, for as long as the usage headers say.
  if ([4, 17, 32, 613].includes(code ?? 0) || ((code ?? 0) >= 80000 && (code ?? 0) <= 80099) || f.status === 429) {
    return new AdsRateLimitedError(msg, metaRetryAfterS(f.headers), "rate_limited", code);
  }
  // 1/2: temporary (1 is also Meta's "reduce the amount of data").
  if (code === 1 || code === 2 || f.status >= 500) return new AdsRetryableError(msg, code);
  return new AdsApiError(msg, f.status, code);
}

/** bizinsights' own app token, which Meta wants for the token inspector (debug_token) and for revoking on a person's behalf. */
const metaAppToken = (c: MetaConfig) => `${c.appId}|${c.appSecret}`;

/**
 * A person's token goes with appsecret_proof, made with the ads app's secret (always bizinsights' own),
 * so a leaked token is useless without it. The app token holds the secret itself and needs none.
 */
const proofFor = (c: MetaConfig, token?: string) => (token && token !== metaAppToken(c) ? c.appSecret : undefined);

/** GET. `path` is relative to the API version, or a `paging.next` link Meta handed back. */
function metaGet<T>(c: MetaConfig, path: string, query: Record<string, string>, token?: string): Promise<T> {
  return graphCall<T>(c.fetchImpl ?? fetch, { version: c.version, method: "GET", path, query, token, appSecret: proofFor(c, token) }, metaAdsError);
}

/** POST and DELETE: the parameters go in the form body. */
function metaSend<T>(c: MetaConfig, method: "POST" | "DELETE", path: string, form: Record<string, string>, token?: string): Promise<T> {
  return graphCall<T>(c.fetchImpl ?? fetch, { version: c.version, method, path, form, token, appSecret: proofFor(c, token) }, metaAdsError);
}

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
 * Take back ads_read only: anything else the person gave bizinsights' Meta app (WhatsApp) stays.
 * "revoked": Meta took it back. "not_granted": the person no longer grants it (they removed it, or
 * the app), so there was nothing left to take back. Anything else throws: it wasn't taken back.
 *
 * A token that stopped working (Meta's last about 60 days) doesn't end the grant itself. With the
 * person's app-scoped id (`externalUserId`), bizinsights' app token takes it back instead: DELETE
 * /{user-id}/permissions/{permission} "must be made with a user access token or an app access token
 * for the current app" (https://developers.facebook.com/docs/graph-api/reference/user/permissions/).
 */
export async function metaRevokeAdsRead(c: MetaConfig, accessToken: string, externalUserId?: string | null): Promise<"revoked" | "not_granted"> {
  try {
    await metaSend(c, "DELETE", "me/permissions/ads_read", {}, accessToken);
    return "revoked";
  } catch (err) {
    const userId = externalUserId && /^\d{1,30}$/.test(externalUserId) ? externalUserId : null;
    if (!(err instanceof AdsAuthError) || !userId) throw err;
    return metaRevokeWithAppToken(c, userId);
  }
}

async function metaRevokeWithAppToken(c: MetaConfig, userId: string): Promise<"revoked" | "not_granted"> {
  const app = metaAppToken(c);
  try {
    const r = await metaSend<{ success?: boolean }>(c, "DELETE", `${userId}/permissions/ads_read`, {}, app);
    if (r?.success === false) throw new AdsApiError("Meta didn't take back ads_read", 502);
    return "revoked";
  } catch (err) {
    // Refused: when Meta lists the person's grants without ads_read, there is nothing left to take back.
    const listed = await metaGet<{ data?: Array<{ permission?: string; status?: string }> }>(c, `${userId}/permissions`, {}, app).catch(() => null);
    if (listed && !(listed.data ?? []).some((p) => p.permission === REQUIRED_AD_SCOPE.meta && p.status === "granted")) return "not_granted";
    throw err;
  }
}

/**
 * What a Meta permission error on an ad account means, as the error to throw: the grant lost ads_read
 * (AdsAuthError "scope_missing": connecting again with it ticked fixes it) or this login lost the
 * account (AdsPermissionError: a login that has access fixes it). Any other error comes back as it is.
 * When Meta can't say what's granted, it stays a permission error.
 */
export async function metaClassifyPermissionError(c: MetaConfig, accessToken: string, err: unknown): Promise<unknown> {
  if (!(err instanceof AdsPermissionError) && !isMetaPermissionError(err)) return err;
  const granted = await metaGrantedPermissions(c, accessToken).catch(() => null);
  if (granted && !granted.includes(REQUIRED_AD_SCOPE.meta)) {
    return Object.assign(new AdsAuthError("Meta's ads_read permission was taken back", "scope_missing"), { cause: err });
  }
  if (err instanceof AdsPermissionError) return err;
  const e = err as AdsApiError;
  return Object.assign(new AdsPermissionError(e.message, e.code), { cause: err });
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

/** Pages of ad accounts read at most: 10,000 accounts, as many as a person can tick in the picker. */
export const META_ACCOUNT_PAGES = 100;

/**
 * Ad accounts the person can read, with each one's status at Meta (disabled, payment needed, closed...)
 * so the picker can say so. An agency login can reach more than can be listed: the list is then
 * marked `truncated`. Never empty: with nothing to connect it throws AdsNoAccountsError, saying whether
 * the login reaches no ad account or the person shared none on Facebook's screen.
 */
export async function metaAdAccounts(c: MetaConfig, accessToken: string): Promise<AdAccountList> {
  type Page = { data?: Array<{ id: string; name?: string; currency?: string; timezone_name?: string; account_status?: number; disable_reason?: number }>; paging?: { next?: string } };
  const out: AdAccount[] = [];
  let page = await metaGet<Page>(c, "me/adaccounts", { fields: "id,name,currency,timezone_name,account_status,disable_reason", limit: "100" }, accessToken);
  let truncated = false;
  for (let i = 1; ; i++) {
    for (const a of page.data ?? []) {
      out.push({ accountId: metaAccountId(a.id), name: a.name ?? null, currency: a.currency ?? null, timezone: a.timezone_name ?? null, ...metaStatusOf(a.account_status, a.disable_reason) });
    }
    const next = page.paging?.next;
    if (!next) break;
    if (i >= META_ACCOUNT_PAGES) {
      truncated = true;
      logger.warn({ listed: out.length }, "meta: login reaches more ad accounts than are listed");
      break;
    }
    page = await metaGet<Page>(c, next, {}, accessToken);
  }
  if (out.length) return adAccountList(out, truncated);
  // Only explains the empty list: a failed look-up still ends in "no ad account".
  const targets = await metaAdsReadTargets(c, accessToken).catch(() => null);
  if (targets) throw new AdsNoAccountsError(`The ads_read grant names ${targets.length ? targets.join(", ") : "no ad account"} and none can be read`, "none_shared");
  throw new AdsNoAccountsError("This Facebook login reaches no ad account");
}

type InsightsPage<R> = { data?: R[]; paging?: { next?: string } };

/** More rows than one read pages through: the caller splits the date range rather than keep part of it. */
class MetaTooManyRowsError extends AdsApiError {
  constructor(what: string) {
    super(`Meta has more ${what} than one read pages through`, 502);
  }
}

/** Read Meta's paging links on from a first page, at most `maxPages` pages; `more` when Meta had more. */
async function metaPagesFrom<R>(c: MetaConfig, accessToken: string, first: InsightsPage<R>, maxPages: number): Promise<{ rows: R[]; more: boolean }> {
  const rows: R[] = [];
  let page = first;
  for (let i = 1; ; i++) {
    rows.push(...(page.data ?? []));
    const next = page.paging?.next;
    if (!next) return { rows, more: false };
    if (i >= maxPages) return { rows, more: true };
    page = await metaGet<InsightsPage<R>>(c, next, {}, accessToken);
  }
}

/**
 * Meta wants a heavy insights read run as a report job: when it answers "reduce the amount of data"
 * (codes 1 and 2), and "in cases where sync calls timeout" (no answer before our time limit), per
 * https://developers.facebook.com/docs/marketing-api/insights/best-practices.
 */
const wantsJob = (err: unknown) => err instanceof MetaNoAnswerError || (err instanceof AdsRetryableError && !(err instanceof AdsRateLimitedError) && (err.code === 1 || err.code === 2));

/** Meta refused a parameter (code 100, "Invalid parameter"), not the account (100 with subcode 33 is a permission error). */
const refusedParameter = (err: unknown) => err instanceof AdsApiError && !(err instanceof AdsPermissionError) && err.code === 100;

/**
 * Every effective_status each level has (the Campaign, Ad Set and Ad references), so archived and
 * deleted ones come back too: without a filter, `/act_<id>/insights?level=<level>` leaves them out of
 * its rows (https://developers.facebook.com/docs/marketing-api/best-practices/manage-your-ad-object-status).
 */
const EVERY_STATUS: Record<MetaReportLevel, string[]> = {
  campaign: ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"],
  adset: ["ACTIVE", "PAUSED", "DELETED", "CAMPAIGN_PAUSED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"],
  ad: ["ACTIVE", "PAUSED", "DELETED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ARCHIVED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES"],
};
const everyStatus = (level: MetaReportLevel) => JSON.stringify([{ field: `${level}.effective_status`, operator: "IN", value: EVERY_STATUS[level] }]);

/** Pages of daily rows read at most per window (25,000 campaign-days); past that the window is split. */
const DAILY_MAX_PAGES = 50;
/** Pages of a report job's results read at most per window (50,000 rows). */
const JOB_MAX_PAGES = 100;

/**
 * Every daily row of one insights read for one window, or an error: never part of the window, since the
 * sync replaces the stored days with what comes back. A heavy read runs as a report job.
 */
async function metaDailyRows(c: MetaConfig, accessToken: string, act: string, params: Record<string, string>, pollMs?: number): Promise<MetaInsightRow[]> {
  let first: InsightsPage<MetaInsightRow>;
  try {
    first = await metaGet<InsightsPage<MetaInsightRow>>(c, `${act}/insights`, params, accessToken);
  } catch (err) {
    if (!wantsJob(err)) throw err;
    return metaInsightsJob(c, accessToken, act, params, pollMs);
  }
  const { rows, more } = await metaPagesFrom(c, accessToken, first, DAILY_MAX_PAGES);
  if (more) throw new MetaTooManyRowsError("daily rows");
  return rows;
}

const DAILY_FIELDS = "spend,impressions,clicks,inline_link_clicks,actions,action_values";

const dailyParams = (level: "campaign" | "account", since: string, until: string, filtered: boolean): Record<string, string> => ({
  level,
  time_increment: "1",
  time_range: JSON.stringify({ since, until }),
  // Link clicks (inline_link_clicks) are what Google counts as clicks; Meta's `clicks` is "clicks (all)".
  fields: level === "campaign" ? `campaign_id,campaign_name,${DAILY_FIELDS}` : DAILY_FIELDS,
  ...(filtered && level === "campaign" ? { filtering: everyStatus("campaign") } : {}),
  // Purchases credited by each ad set's own attribution setting, the way Ads Manager counts them.
  use_unified_attribution_setting: "true",
  limit: "500",
});

/** The campaign rows of one window, split in halves while one read can't page through it all. */
async function metaCampaignWindow(c: MetaConfig, accessToken: string, act: string, since: string, until: string, pollMs: number | undefined, filtered = true): Promise<MetaInsightRow[]> {
  try {
    return await metaDailyRows(c, accessToken, act, dailyParams("campaign", since, until, filtered), pollMs);
  } catch (err) {
    if (err instanceof MetaTooManyRowsError && since < until) {
      const mid = addDays(since, Math.floor((daysBetweenInclusive(since, until) - 1) / 2));
      const first = await metaCampaignWindow(c, accessToken, act, since, mid, pollMs, filtered);
      return [...first, ...(await metaCampaignWindow(c, accessToken, act, addDays(mid, 1), until, pollMs, filtered))];
    }
    // Meta refusing the status filter itself: read without it. The account-level rows still account
    // for archived and deleted campaigns (metaCampaignDays).
    if (filtered && refusedParameter(err)) {
      logger.warn({ err, act }, "meta: the status filter was refused; reading campaigns without it");
      return metaCampaignWindow(c, accessToken, act, since, until, pollMs, false);
    }
    throw err;
  }
}

/** The row that keeps a day's stored total equal to Meta's account total. */
export const META_OTHER_CAMPAIGNS = { campaignId: "other", campaignName: "Other campaigns (archived or deleted)" } as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Per day, what the account spent (and was credited) beyond its listed campaigns, as one more campaign
 * row: what Meta leaves out of a campaign-level read (deleted campaigns, and archived ones if the
 * status filter was refused) still counts in the account's totals and in what Meta bills.
 */
export function withMetaOtherCampaigns(act: string, campaigns: AdDayRow[], account: AdDayRow[]): AdDayRow[] {
  type Sums = Pick<AdDayRow, "spend" | "impressions" | "clicks" | "conversions" | "conversionValue" | "leads"> & { linkClicks: number; purchases: number; purchaseValue: number };
  const zero = (): Sums => ({ spend: 0, impressions: 0, clicks: 0, linkClicks: 0, conversions: 0, conversionValue: 0, purchases: 0, purchaseValue: 0, leads: 0 });
  const byDay = new Map<string, Sums>();
  for (const r of campaigns) {
    const s = byDay.get(r.day) ?? zero();
    s.spend += r.spend;
    s.impressions += r.impressions;
    s.clicks += r.clicks;
    s.linkClicks += r.linkClicks ?? 0;
    s.conversions += r.conversions;
    s.conversionValue += r.conversionValue;
    s.purchases += r.purchases ?? 0;
    s.purchaseValue += r.purchaseValue ?? 0;
    s.leads += r.leads;
    byDay.set(r.day, s);
  }
  // Never below zero: a campaign's figures can come out a cent above the account's after rounding.
  const gap = (whole: number | null, part: number) => Math.max(0, round2((whole ?? 0) - part));
  const out = [...campaigns];
  for (const a of account) {
    const s = byDay.get(a.day) ?? zero();
    const row: AdDayRow = {
      provider: "meta",
      accountId: act,
      ...META_OTHER_CAMPAIGNS,
      day: a.day,
      spend: gap(a.spend, s.spend),
      impressions: gap(a.impressions, s.impressions),
      clicks: gap(a.clicks, s.clicks),
      linkClicks: a.linkClicks === null ? null : gap(a.linkClicks, s.linkClicks),
      conversions: gap(a.conversions, s.conversions),
      conversionValue: gap(a.conversionValue, s.conversionValue),
      purchases: a.purchases === null ? null : gap(a.purchases, s.purchases),
      purchaseValue: a.purchaseValue === null ? null : gap(a.purchaseValue, s.purchaseValue),
      leads: gap(a.leads, s.leads),
    };
    const counts = [row.spend, row.impressions, row.clicks, row.linkClicks ?? 0, row.conversions, row.conversionValue, row.purchases ?? 0, row.purchaseValue ?? 0, row.leads];
    if (counts.some((n) => n > 0)) out.push(row);
  }
  return out;
}

/**
 * Spend, impressions, clicks (all, and on the ad's link), purchases and leads per campaign per day,
 * from `since` to `until`, archived and deleted campaigns included: the campaigns come with every
 * effective_status, and whatever the account spent beyond them is kept as one "Other campaigns" row
 * per day (from the account-level daily totals), so the stored days always add up to Meta's account
 * total. Every day of the window or an error, never part of it.
 */
export async function metaCampaignDays(c: MetaConfig, accessToken: string, accountId: string, since: string, until: string, opts: { pollMs?: number } = {}): Promise<AdDayRow[]> {
  if (!isDay(since) || !isDay(until) || since > until) throw new AdsApiError(`Invalid date range ${since}..${until}`, 400);
  const act = metaAccountId(accountId);
  const [campaigns, account] = await Promise.all([
    metaCampaignWindow(c, accessToken, act, since, until, opts.pollMs),
    metaDailyRows(c, accessToken, act, dailyParams("account", since, until, false), opts.pollMs),
  ]);
  return withMetaOtherCampaigns(
    act,
    campaigns.map((r) => fromMetaInsight(act, r)),
    account.map((r) => fromMetaInsight(act, r)),
  );
}

/**
 * Wait for a report job: "Job Completed" with async_percent_completion 100, as Meta says to poll
 * (https://developers.facebook.com/docs/marketing-api/insights/best-practices). A failed job's own
 * error (error_code, error_message: v25.0 and later) is what's thrown; one still running after
 * `polls` checks throws `stillRunning()`.
 */
async function metaJobDone(c: MetaConfig, accessToken: string, id: string, pollMs: number, polls: number, stillRunning: () => Error): Promise<void> {
  for (let i = 0; ; i++) {
    const s = await metaGet<{ async_status?: string; async_percent_completion?: number | string }>(c, id, { fields: "async_status,async_percent_completion" }, accessToken);
    if (s.async_status === "Job Completed" && Number(s.async_percent_completion) >= 100) return;
    if (s.async_status === "Job Failed") throw await metaJobFailure(c, accessToken, id);
    // Expired before it ran: a new job would have to be started.
    if (s.async_status === "Job Skipped") throw new AdsRetryableError("Meta skipped the report job");
    if (i >= polls) throw stillRunning();
    if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Why a report job failed, sorted like any Graph API failure; a failure Meta doesn't explain is worth a retry. */
async function metaJobFailure(c: MetaConfig, accessToken: string, id: string): Promise<Error> {
  type Why = { error_code?: number | string; error_message?: string; error_subcode?: number | string; error_user_title?: string; error_user_msg?: string };
  const why = await metaGet<Why>(c, id, { fields: "error_code,error_message,error_subcode,error_user_title,error_user_msg" }, accessToken).catch((): Why => ({}));
  const code = Number(why.error_code) || null;
  const message = `Meta's report job failed${why.error_message ? `: ${why.error_message}` : ""}`;
  if (code === null) return new AdsRetryableError(message);
  return metaAdsError({
    reason: "refused",
    status: 400,
    code,
    subcode: Number(why.error_subcode) || null,
    type: null,
    message,
    userTitle: why.error_user_title ?? null,
    userMessage: why.error_user_msg ?? null,
    details: null,
    text: null,
    headers: null,
  });
}

/**
 * An asynchronous Insights report: start the job, wait for it (about 8 minutes at most by default),
 * then read all its pages. A job still running then is a temporary failure, so the queue tries again
 * later; more rows than JOB_MAX_PAGES pages hold is an error, never part of them.
 */
export async function metaInsightsJob<R = MetaInsightRow>(
  c: MetaConfig,
  accessToken: string,
  act: string,
  params: Record<string, string>,
  pollMs = 5000,
  opts: { polls?: number; stillRunning?: () => Error; maxPages?: number; allowMore?: boolean } = {},
): Promise<R[]> {
  return (await metaJobRows<R>(c, accessToken, act, params, pollMs, opts)).rows;
}

async function metaJobRows<R>(
  c: MetaConfig,
  accessToken: string,
  act: string,
  params: Record<string, string>,
  pollMs: number,
  opts: { polls?: number; stillRunning?: () => Error; maxPages?: number; allowMore?: boolean },
): Promise<{ rows: R[]; more: boolean }> {
  const { limit: pageSize = "500", ...jobParams } = params;
  const job = await metaSend<{ report_run_id?: string }>(c, "POST", `${act}/insights`, jobParams, accessToken);
  const id = job.report_run_id;
  if (!id || !/^\d{1,30}$/.test(id)) throw new AdsApiError("Meta didn't start the report", 502);
  // About 8 minutes: a queue consumer may run for 15, and a retry would only start the job again.
  await metaJobDone(c, accessToken, id, pollMs, opts.polls ?? 96, opts.stillRunning ?? (() => new AdsRetryableError("Meta's report is taking longer than usual")));
  const first = await metaGet<InsightsPage<R>>(c, `${id}/insights`, { limit: pageSize }, accessToken);
  const read = await metaPagesFrom(c, accessToken, first, opts.maxPages ?? JOB_MAX_PAGES);
  if (read.more && !opts.allowMore) throw new MetaTooManyRowsError("report rows");
  return read;
}

const RANGE_FIELDS = "spend,impressions,reach,frequency,clicks,inline_link_clicks,actions,action_values";
const LEVEL_FIELDS: Record<MetaReportLevel, string> = {
  campaign: "campaign_id,campaign_name",
  adset: "campaign_name,adset_id,adset_name,attribution_setting",
  ad: "campaign_name,adset_name,ad_id,ad_name,attribution_setting",
};

/**
 * How long a live report waits for a report job: about 15 seconds. The API's whole request has 55, and
 * the synchronous try before it may have used 30 of them.
 */
export const META_REPORT_JOB = { pollMs: 1500, polls: 10 } as const;

/**
 * Totals for one whole range, for the account or per campaign / ad set / ad (archived and deleted ones
 * included, biggest spend first). Results follow each ad set's own attribution setting, as Ads Manager
 * shows them. A range too heavy to answer at once runs as a report job; one that isn't done within
 * META_REPORT_JOB throws AdsReportPendingError, so the person can be told to look again in a minute.
 */
export async function metaRangeInsights(
  c: MetaConfig,
  accessToken: string,
  accountId: string,
  level: "account" | MetaReportLevel,
  since: string,
  until: string,
  maxRows = 2000,
  /** Split the account's numbers by placement, device, country, age or gender (level "account" only). */
  breakdown?: MetaReportBreakdown,
  opts: { pollMs?: number; polls?: number } = {},
): Promise<MetaRangeInsight[]> {
  return (await metaRangeRead(c, accessToken, accountId, level, since, until, maxRows, breakdown, opts)).rows;
}

/** metaRangeInsights, saying whether Meta had more rows than `maxRows`. */
async function metaRangeRead(
  c: MetaConfig,
  accessToken: string,
  accountId: string,
  level: "account" | MetaReportLevel,
  since: string,
  until: string,
  maxRows: number,
  breakdown: MetaReportBreakdown | undefined,
  opts: { pollMs?: number; polls?: number },
  extras = true,
): Promise<{ rows: MetaRangeInsight[]; more: boolean }> {
  if (!isDay(since) || !isDay(until)) throw new AdsApiError(`Invalid date range ${since}..${until}`, 400);
  const act = metaAccountId(accountId);
  const pageSize = Math.min(500, Math.max(1, maxRows));
  const params: Record<string, string> = {
    level,
    time_range: JSON.stringify({ since, until }),
    fields: level === "account" ? RANGE_FIELDS : `${LEVEL_FIELDS[level]},${RANGE_FIELDS}`,
    ...(breakdown && level === "account" ? { breakdowns: META_BREAKDOWN_PARAM[breakdown] } : {}),
    ...(extras && level !== "account" ? { filtering: everyStatus(level) } : {}),
    // Biggest spend first, so the rows read before the cap are the ones that spent most.
    ...(extras ? { sort: JSON.stringify(["spend_descending"]) } : {}),
    use_unified_attribution_setting: "true",
    limit: String(pageSize),
  };
  const maxPages = Math.ceil(maxRows / pageSize);
  try {
    let first: InsightsPage<MetaRangeInsight>;
    try {
      first = await metaGet<InsightsPage<MetaRangeInsight>>(c, `${act}/insights`, params, accessToken);
    } catch (err) {
      if (!wantsJob(err)) throw err;
      const job = await metaJobRows<MetaRangeInsight>(c, accessToken, act, params, opts.pollMs ?? META_REPORT_JOB.pollMs, {
        polls: opts.polls ?? META_REPORT_JOB.polls,
        stillRunning: () => new AdsReportPendingError("Meta is still preparing this report"),
        maxPages,
        allowMore: true,
      });
      return { rows: job.rows.slice(0, maxRows), more: job.more || job.rows.length > maxRows };
    }
    const read = await metaPagesFrom(c, accessToken, first, maxPages);
    return { rows: read.rows.slice(0, maxRows), more: read.more || read.rows.length > maxRows };
  } catch (err) {
    // Meta refusing the status filter or the sort: the report still comes, without them.
    if (extras && refusedParameter(err)) {
      logger.warn({ err, act, level }, "meta: a report parameter was refused; asking without the status filter and sort");
      return metaRangeRead(c, accessToken, accountId, level, since, until, maxRows, breakdown, opts, false);
    }
    throw err;
  }
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

/**
 * By campaign, ad set or ad (with each one's delivery status), or the whole account split by placement,
 * device, country, age or gender. Range-based: a comparison asks for its own range with a second call.
 */
export async function metaReport(
  c: MetaConfig,
  accessToken: string,
  accountId: string,
  level: MetaReportView,
  since: string,
  until: string,
  maxRows = 200,
  opts: { pollMs?: number; polls?: number } = {},
): Promise<MetaReport> {
  const breakdown = isMetaBreakdown(level) ? level : null;
  const [account, raw] = await Promise.all([
    metaRangeRead(c, accessToken, accountId, "account", since, until, 2000, undefined, opts),
    breakdown ? metaRangeRead(c, accessToken, accountId, "account", since, until, 2000, breakdown, opts) : metaRangeRead(c, accessToken, accountId, level as MetaReportLevel, since, until, 2000, undefined, opts),
  ]);
  const all = raw.rows
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
    totals: metaReportMetrics(account.rows[0] ?? { reach: "0" }),
    rows,
    truncated: all.length > rows.length || raw.more,
    attribution: [...new Set(all.map((r) => r.attribution).filter((a): a is string => !!a))],
  };
}

/** Meta's disable_reason codes, in words (https://developers.facebook.com/docs/marketing-api/reference/ad-account/). */
const META_DISABLE_REASON: Record<number, string> = {
  1: "Meta's advertising policies",
  2: "an intellectual property review",
  3: "a payment problem",
  4: "the account was shut down",
  5: "an advertising review",
  6: "a business integrity review",
  7: "the account was closed for good",
  8: "an unused reseller account",
  9: "the account wasn't used",
  11: "a business portfolio policy review",
  12: "a misrepresented account",
  15: "the account may have been compromised",
};

/**
 * One ad account's health as Meta reports it now: its account_status (normalized), why it is
 * disabled, and its name, currency and time zone. One cheap call, made with the daily re-check.
 */
export async function metaAccountHealth(c: MetaConfig, accessToken: string, accountId: string): Promise<AdAccountHealth> {
  const act = metaAccountId(accountId);
  if (!/^act_\d{1,30}$/.test(act)) throw new AdsApiError(`Invalid Meta ad account ${accountId}`, 400);
  const a = await metaGet<{ account_status?: number; disable_reason?: number; name?: string; currency?: string; timezone_name?: string }>(c, act, {
    fields: "account_status,disable_reason,name,currency,timezone_name",
  }, accessToken);
  const s = metaStatusOf(a.account_status, a.disable_reason);
  return { status: s.status, detail: s.statusDetail, name: a.name ?? null, currency: a.currency ?? null, timezone: a.timezone_name ?? null };
}

/** Meta's account_status and disable_reason → the account's status, and why when it isn't active. */
function metaStatusOf(accountStatus: number | undefined, disableReason: number | undefined): { status: AdAccountStatus | null; statusDetail: string | null } {
  const status = metaAccountStatus(accountStatus);
  const reason = disableReason ? META_DISABLE_REASON[disableReason] : undefined;
  return { status, statusDetail: status && status !== "active" && reason ? `Because of ${reason}` : null };
}

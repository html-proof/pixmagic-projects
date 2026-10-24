/**
 * Meta Marketing API, read with a token of bizinsights' own Meta app that Nango holds ("Continue with
 * Meta Ads", ads_read only; docs/nango.md): the ad accounts a person can read, daily numbers per
 * campaign and the report by campaign, ad set, ad or breakdown. Every call goes through the shared
 * Graph API transport (metaGraph.ts).
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
  META_OBJECT_FIELDS,
  metaAccountId,
  metaAccountStatus,
  metaCountCampaign,
  metaObjectDetails,
  metaReportMetrics,
  noMetaCampaignCounts,
  type AdAccountStatus,
  type AdDayRow,
  type MetaCampaignCounts,
  type MetaInsightRow,
  type MetaListedObject,
  type MetaObjectDetails,
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
  AD_DISCOVERY_BUDGET_MS,
  adAccountListWithin,
  AdsApiError,
  AdsAuthError,
  AdsNoAccountsError,
  AdsPermissionError,
  AdsRateLimitedError,
  AdsReportPendingError,
  AdsRetryableError,
  isMetaPermissionError,
  REQUIRED_AD_SCOPE,
  type AdAccount,
  type AdAccountHealth,
  type AdAccountList,
} from "./common.js";

export interface MetaConfig {
  appId: string;
  appSecret: string;
  /** Graph / Marketing API version, e.g. "v26.0". */
  version: string;
  /**
   * Facebook Login for Business: the Login Configuration made in the app dashboard (user access
   * token, ads_read). Meta recommends it over `scope`; without one, classic Facebook Login's
   * `scope` is used.
   */
  configId?: string;
  fetchImpl?: FetchLike;
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
  // 100 "Invalid appsecret_proof": the token wasn't issued to the app whose secret signs our calls (a
  // Nango integration holding other keys, or a META_APP_SECRET that isn't this app's). Ours to fix,
  // never the person's, and no retry or other login changes it.
  if (code === 100 && /appsecret_proof/i.test(msg)) return new AdsApiError(msg, f.status, code, "not_configured");
  return new AdsApiError(msg, f.status, code);
}

/** bizinsights' own app token, which Meta wants for the token inspector (debug_token) and for revoking on a person's behalf. */
const metaAppToken = (c: MetaConfig) => `${c.appId}|${c.appSecret}`;

/**
 * A person's token goes with appsecret_proof, made with the ads app's secret (always bizinsights' own),
 * so a leaked token is useless without it. The app token holds the secret itself and needs none.
 */
const proofFor = (c: MetaConfig, token?: string) => (token && token !== metaAppToken(c) ? c.appSecret : undefined);

/**
 * The time a read made inside an API request has (a live report, the account list at sign-in): no call
 * starts after `deadline` (epoch ms), and each gets what's left of it, at most `capMs`.
 */
interface CallLimit {
  deadline: number;
  capMs?: number;
}

/**
 * The read ran out of the time its request has. A live report says Meta is still preparing it (the
 * person can look again in a minute); the account list stops there and says it was cut.
 */
class MetaOutOfTimeError extends AdsReportPendingError {
  constructor() {
    super("Meta is still preparing this report");
  }
}

/** Run one call within `limit`: out of time before it or during it is MetaOutOfTimeError; without a limit, the fetch's own applies. */
async function withinLimit<T>(limit: CallLimit | undefined, call: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (!limit) return call();
  const left = limit.deadline - Date.now();
  if (left <= 0) throw new MetaOutOfTimeError();
  try {
    return await call(AbortSignal.timeout(Math.min(left, limit.capMs ?? left)));
  } catch (err) {
    // No answer and no time left: the request's time ran out, not just this call's share of it.
    if (err instanceof MetaNoAnswerError && Date.now() >= limit.deadline - 50) throw new MetaOutOfTimeError();
    throw err;
  }
}

/** GET. `path` is relative to the API version, or a `paging.next` link Meta handed back. */
function metaGet<T>(c: MetaConfig, path: string, query: Record<string, string>, token?: string, limit?: CallLimit): Promise<T> {
  return withinLimit(limit, (signal) => graphCall<T>(c.fetchImpl ?? fetch, { version: c.version, method: "GET", path, query, token, appSecret: proofFor(c, token), signal }, metaAdsError));
}

/** POST and DELETE: the parameters go in the form body. */
function metaSend<T>(c: MetaConfig, method: "POST" | "DELETE", path: string, form: Record<string, string>, token?: string, limit?: CallLimit): Promise<T> {
  return withinLimit(limit, (signal) => graphCall<T>(c.fetchImpl ?? fetch, { version: c.version, method, path, form, token, appSecret: proofFor(c, token), signal }, metaAdsError));
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
 * Without that id, Meta's token inspector is asked whose token it was.
 */
export async function metaRevokeAdsRead(c: MetaConfig, accessToken: string, externalUserId?: string | null): Promise<"revoked" | "not_granted"> {
  try {
    await metaSend(c, "DELETE", "me/permissions/ads_read", {}, accessToken);
    return "revoked";
  } catch (err) {
    if (!(err instanceof AdsAuthError)) throw err;
    const userId = (externalUserId && /^\d{1,30}$/.test(externalUserId) ? externalUserId : null) ?? (await metaTokenUserId(c, accessToken));
    if (!userId) throw err;
    return metaRevokeWithAppToken(c, userId);
  }
}

/**
 * Who a token that no longer works was issued to: `user_id` from Meta's token inspector, asked with the
 * app token (https://developers.facebook.com/docs/graph-api/reference/debug_token/). Null when Meta
 * doesn't say, or says the token is another app's.
 */
async function metaTokenUserId(c: MetaConfig, accessToken: string): Promise<string | null> {
  const r = await metaGet<{ data?: { app_id?: string; user_id?: string } }>(c, "debug_token", { input_token: accessToken }, metaAppToken(c)).catch(() => null);
  const d = r?.data;
  if (!d || (d.app_id && d.app_id !== c.appId)) return null;
  return d.user_id && /^\d{1,30}$/.test(d.user_id) ? d.user_id : null;
}

/** Take ads_read back for the person with app-scoped id `userId`, with bizinsights' app token (their own token no longer works). */
export async function metaRevokeWithAppToken(c: MetaConfig, userId: string): Promise<"revoked" | "not_granted"> {
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
  return adsReadTargetsOf(await metaInspectToken(c, accessToken));
}

/** What Meta's token inspector says about a person's token (https://developers.facebook.com/docs/graph-api/reference/debug_token/). */
interface MetaTokenInspection {
  type?: string;
  app_id?: string;
  is_valid?: boolean;
  user_id?: string;
  scopes?: string[];
  granular_scopes?: Array<{ scope?: string; target_ids?: string[] }>;
}

async function metaInspectToken(c: MetaConfig, accessToken: string): Promise<MetaTokenInspection> {
  const r = await metaGet<{ data?: MetaTokenInspection }>(c, "debug_token", { input_token: accessToken }, metaAppToken(c));
  return r.data ?? {};
}

const adsReadTargetsOf = (t: MetaTokenInspection) => (t.granular_scopes ?? []).find((g) => g.scope === REQUIRED_AD_SCOPE.meta)?.target_ids ?? null;

/** A look-up's outcome without a throw. */
const settle = <T>(p: Promise<T>): Promise<{ value: T; err?: undefined } | { value?: undefined; err: unknown }> =>
  p.then(
    (value) => ({ value }),
    (err: unknown) => ({ err }),
  );

/**
 * A diagnosis look-up Meta refused or didn't answer: Meta's code (or the HTTP status; "auth" for a token
 * refused, which for the inspector means bizinsights' app token) and Meta's words, which hold no token.
 */
const lookUpFailed = (err: unknown) => ({
  failed: err instanceof AdsApiError ? (err.code ?? err.status) : err instanceof AdsAuthError ? "auth" : err instanceof Error ? err.name : "error",
  ...(err instanceof Error ? { message: err.message.slice(0, 160) } : {}),
});

/**
 * What Meta says about a login whose ad account list came back empty, so the log tells the cases apart
 * without anyone asking Meta by hand: who signed in (the app-scoped id), what the token is (its type, its
 * app, whether it works, the permissions it carries and the ad accounts ads_read names) and the role that
 * person has on bizinsights' Meta app (with Standard Access, only people with one can grant ads_read).
 * Each look-up is best effort: one Meta refuses is noted as failed, never thrown.
 */
async function metaEmptyList(c: MetaConfig, accessToken: string): Promise<{ diagnosis: Record<string, unknown>; targets: string[] | null; loginName: string | null }> {
  const [me, inspected] = await Promise.all([settle(metaGet<{ id?: string; name?: string }>(c, "me", { fields: "id,name" }, accessToken)), settle(metaInspectToken(c, accessToken))]);
  const t = inspected.value;
  const userId = [me.value?.id, t?.user_id].find((id): id is string => !!id && /^\d{1,30}$/.test(id)) ?? null;
  // The app's roles list the people by the ids the app knows them by, as the token's own id is.
  const roles = userId ? await settle(metaGet<{ data?: Array<{ user?: string; role?: string }> }>(c, `${c.appId}/roles`, { limit: "100" }, metaAppToken(c))) : null;
  const targets = t ? adsReadTargetsOf(t) : null;
  const diagnosis: Record<string, unknown> = {
    metaUserId: userId,
    ...(me.err !== undefined ? { me: lookUpFailed(me.err) } : {}),
    token: t
      ? {
          type: t.type ?? null,
          ownApp: t.app_id ? t.app_id === c.appId : null,
          valid: t.is_valid ?? null,
          scopes: t.scopes ?? null,
          // Per permission, how many accounts or pages it names ("all": it names none, so it covers what the login reaches).
          granted: Object.fromEntries((t.granular_scopes ?? []).filter((g) => g.scope).map((g) => [g.scope!, g.target_ids ? g.target_ids.length : "all"])),
        }
      : lookUpFailed(inspected.err),
    appRole: !roles ? null : roles.value ? ((roles.value.data ?? []).find((r) => r.user === userId)?.role ?? "none") : lookUpFailed(roles.err),
    ...(roles?.value ? { appRolesListed: (roles.value.data ?? []).length } : {}),
  };
  return { diagnosis, targets, loginName: me.value?.name?.trim().slice(0, 120) || null };
}

/** Pages of ad accounts read at most (2,000 accounts): the sign-in reads them all before the person picks. */
export const META_ACCOUNT_PAGES = 20;

/**
 * Ad accounts the person can read, with each one's status at Meta (disabled, payment needed, closed...)
 * so the picker can say so. Read inside the OAuth callback, so the list stops at META_ACCOUNT_PAGES
 * pages, at AD_DISCOVERY_BUDGET_MS (`budgetMs`) after the first page, and at what the sign-in can hold
 * while the person picks (AD_ACCOUNT_LIST_MAX_BYTES): an agency login that reaches more gets the list
 * marked `truncated`. Never empty: with nothing to connect it throws AdsNoAccountsError, saying whether
 * the login reaches no ad account or the person shared none on Facebook's screen.
 */
export async function metaAdAccounts(c: MetaConfig, accessToken: string, opts: { budgetMs?: number } = {}): Promise<AdAccountList> {
  type Page = { data?: Array<{ id: string; name?: string; currency?: string; timezone_name?: string; account_status?: number; disable_reason?: number }>; paging?: { next?: string } };
  const out: AdAccount[] = [];
  let page = await metaGet<Page>(c, "me/adaccounts", { fields: "id,name,currency,timezone_name,account_status,disable_reason", limit: "100" }, accessToken);
  const limit: CallLimit = { deadline: Date.now() + (opts.budgetMs ?? AD_DISCOVERY_BUDGET_MS) };
  let cut: "pages" | "time" | null = null;
  for (let i = 1; ; i++) {
    for (const a of page.data ?? []) {
      out.push({ accountId: metaAccountId(a.id), name: a.name ?? null, currency: a.currency ?? null, timezone: a.timezone_name ?? null, ...metaStatusOf(a.account_status, a.disable_reason) });
    }
    const next = page.paging?.next;
    if (!next) break;
    if (i >= META_ACCOUNT_PAGES) {
      cut = "pages";
      break;
    }
    try {
      page = await metaGet<Page>(c, next, {}, accessToken, limit);
    } catch (err) {
      // Out of time: the accounts read so far, said to be cut, rather than a sign-in that never comes back.
      if (!(err instanceof MetaOutOfTimeError)) throw err;
      cut = "time";
      break;
    }
  }
  const list = adAccountListWithin(out, cut !== null);
  if (list.truncated) logger.warn({ read: out.length, listed: list.length, cut: cut ?? "size" }, "meta: login reaches more ad accounts than one sign-in lists");
  if (list.length) return list;
  // Only explains the empty list: a failed look-up still ends in "no ad account".
  const { diagnosis, targets, loginName } = await metaEmptyList(c, accessToken);
  if (targets) throw new AdsNoAccountsError(`The ads_read grant names ${targets.length ? targets.join(", ") : "no ad account"} and none can be read`, "none_shared", diagnosis, loginName);
  throw new AdsNoAccountsError("This Facebook login reaches no ad account", "no_ads_account", diagnosis, loginName);
}

type InsightsPage<R> = { data?: R[]; paging?: { next?: string } };

/** More rows than one read pages through: the caller splits the date range rather than keep part of it. */
class MetaTooManyRowsError extends AdsApiError {
  constructor(what: string) {
    super(`Meta has more ${what} than one read pages through`, 502);
  }
}

/** Read Meta's paging links on from a first page, at most `maxPages` pages; `more` when Meta had more. */
async function metaPagesFrom<R>(c: MetaConfig, accessToken: string, first: InsightsPage<R>, maxPages: number, limit?: CallLimit): Promise<{ rows: R[]; more: boolean }> {
  const rows: R[] = [];
  let page = first;
  for (let i = 1; ; i++) {
    rows.push(...(page.data ?? []));
    const next = page.paging?.next;
    if (!next) return { rows, more: false };
    if (i >= maxPages) return { rows, more: true };
    page = await metaGet<InsightsPage<R>>(c, next, {}, accessToken, limit);
  }
}

/**
 * Meta wants a heavy insights read run as a report job: when it answers "reduce the amount of data"
 * (codes 1 and 2), and "in cases where sync calls timeout" (no answer before our time limit), per
 * https://developers.facebook.com/docs/marketing-api/insights/best-practices.
 */
const wantsJob = (err: unknown) => err instanceof MetaNoAnswerError || (err instanceof AdsRetryableError && !(err instanceof AdsRateLimitedError) && (err.code === 1 || err.code === 2));

/** Meta refused a parameter (code 100, "Invalid parameter"), not the account (100 with subcode 33 is a permission error) nor our appsecret_proof. */
const refusedParameter = (err: unknown) => err instanceof AdsApiError && !(err instanceof AdsPermissionError) && err.code === 100 && err.errorCode !== "not_configured";

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
 *
 * Meta rounds money to the cent at each level, so the campaigns' sum can miss the account's by up to
 * half a cent per row either way. A gap only in money and within that is rounding, not a campaign: no
 * row. A whole impression, click or action that no listed campaign has always makes one.
 */
export function withMetaOtherCampaigns(act: string, campaigns: AdDayRow[], account: AdDayRow[]): AdDayRow[] {
  type Sums = Pick<AdDayRow, "spend" | "impressions" | "clicks" | "conversions" | "conversionValue" | "leads"> & { linkClicks: number; purchases: number; purchaseValue: number; rows: number };
  const zero = (): Sums => ({ spend: 0, impressions: 0, clicks: 0, linkClicks: 0, conversions: 0, conversionValue: 0, purchases: 0, purchaseValue: 0, leads: 0, rows: 0 });
  const byDay = new Map<string, Sums>();
  for (const r of campaigns) {
    const s = byDay.get(r.day) ?? zero();
    s.rows++;
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
    const counts = [row.impressions, row.clicks, row.linkClicks ?? 0, row.conversions, row.purchases ?? 0, row.leads];
    // Half a cent for each campaign row and for the account's own figure.
    const rounding = 0.005 * (s.rows + 1) + 1e-9;
    const money = [row.spend, row.conversionValue, row.purchaseValue ?? 0];
    if (counts.some((n) => n >= 1) || money.some((n) => n > rounding)) out.push(row);
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
 * `polls` checks, or (within a request's `limit`) with no time left for another wait and the read
 * after it, throws `stillRunning()`.
 */
async function metaJobDone(c: MetaConfig, accessToken: string, id: string, pollMs: number, polls: number, stillRunning: () => Error, limit?: CallLimit): Promise<void> {
  for (let i = 0; ; i++) {
    const s = await metaGet<{ async_status?: string; async_percent_completion?: number | string }>(c, id, { fields: "async_status,async_percent_completion" }, accessToken, limit);
    if (s.async_status === "Job Completed" && Number(s.async_percent_completion) >= 100) return;
    if (s.async_status === "Job Failed") throw await metaJobFailure(c, accessToken, id, limit);
    // Expired before it ran: a new job would have to be started.
    if (s.async_status === "Job Skipped") throw new AdsRetryableError("Meta skipped the report job");
    if (i >= polls || (limit && Date.now() + pollMs + META_REPORT_JOB.readMs >= limit.deadline)) throw stillRunning();
    if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Why a report job failed, sorted like any Graph API failure; a failure Meta doesn't explain is worth a retry. */
async function metaJobFailure(c: MetaConfig, accessToken: string, id: string, limit?: CallLimit): Promise<Error> {
  type Why = { error_code?: number | string; error_message?: string; error_subcode?: number | string; error_user_title?: string; error_user_msg?: string };
  const why = await metaGet<Why>(c, id, { fields: "error_code,error_message,error_subcode,error_user_title,error_user_msg" }, accessToken, limit).catch((): Why => ({}));
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
  /** `limit`: the time of the request the job runs within (a live report). */
  opts: { polls?: number; stillRunning?: () => Error; maxPages?: number; allowMore?: boolean; limit?: CallLimit },
): Promise<{ rows: R[]; more: boolean }> {
  const { limit: pageSize = "500", ...jobParams } = params;
  const job = await metaSend<{ report_run_id?: string }>(c, "POST", `${act}/insights`, jobParams, accessToken, opts.limit);
  const id = job.report_run_id;
  if (!id || !/^\d{1,30}$/.test(id)) throw new AdsApiError("Meta didn't start the report", 502);
  // About 8 minutes: a queue consumer may run for 15, and a retry would only start the job again.
  await metaJobDone(c, accessToken, id, pollMs, opts.polls ?? 96, opts.stillRunning ?? (() => new AdsRetryableError("Meta's report is taking longer than usual")), opts.limit);
  const first = await metaGet<InsightsPage<R>>(c, `${id}/insights`, { limit: pageSize }, accessToken, opts.limit);
  const read = await metaPagesFrom(c, accessToken, first, opts.maxPages ?? JOB_MAX_PAGES, opts.limit);
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
 * A live report's time. The API has 55 seconds for the whole request and needs some of them itself, so
 * Meta's reads get `budgetMs` from when the report is asked. The synchronous try gets at most `syncMs`
 * of it: past that the range runs as a report job (Meta's advice when a synchronous read times out),
 * checked every `pollMs` while `readMs` is still left to read its results. The rows' delivery
 * statuses are looked up only with `statusMs` left.
 */
export const META_REPORT_JOB = { budgetMs: 40_000, syncMs: 15_000, pollMs: 1500, readMs: 6000, statusMs: 3000 } as const;

/**
 * How a live report runs. `deadline` (epoch ms): when Meta's reads must be done, by default
 * META_REPORT_JOB.budgetMs from the call (two reports in one request, a comparison, share one).
 * `pollMs`, `polls` and `syncMs` override META_REPORT_JOB's (tests).
 */
export interface MetaLiveReportOptions {
  deadline?: number;
  pollMs?: number;
  polls?: number;
  syncMs?: number;
  /**
   * False: leave each row's delivery status and settings unknown (null) and the campaign counts
   * unread, for a range read only for its figures (a comparison's): those are list calls on Meta's
   * rate limit. Default true.
   */
  statuses?: boolean;
  /** The ad account's currency, for the budgets in each row's settings. */
  currency?: string | null;
}

/**
 * Totals for one whole range, for the account or per campaign / ad set / ad (archived and deleted ones
 * included, biggest spend first). Results follow each ad set's own attribution setting, as Ads Manager
 * shows them. A range too heavy to answer at once runs as a report job; one that isn't done within the
 * request's time (META_REPORT_JOB) throws AdsReportPendingError, so the person can be told to look
 * again in a minute.
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
  opts: MetaLiveReportOptions = {},
): Promise<MetaRangeInsight[]> {
  const deadline = opts.deadline ?? Date.now() + META_REPORT_JOB.budgetMs;
  return (await metaRangeRead(c, accessToken, accountId, level, since, until, maxRows, breakdown, { ...opts, deadline })).rows;
}

/**
 * metaRangeInsights, saying whether Meta had more rows than `maxRows`. Every call is made within
 * `opts.deadline`. `asJob`: the range is already known to be too heavy for one answer.
 */
async function metaRangeRead(
  c: MetaConfig,
  accessToken: string,
  accountId: string,
  level: "account" | MetaReportLevel,
  since: string,
  until: string,
  maxRows: number,
  breakdown: MetaReportBreakdown | undefined,
  opts: MetaLiveReportOptions & { deadline: number },
  extras = true,
  asJob = false,
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
  const limit: CallLimit = { deadline: opts.deadline };
  let job = asJob;
  try {
    if (!job) {
      let first: InsightsPage<MetaRangeInsight> | null = null;
      try {
        first = await metaGet<InsightsPage<MetaRangeInsight>>(c, `${act}/insights`, params, accessToken, { ...limit, capMs: opts.syncMs ?? META_REPORT_JOB.syncMs });
      } catch (err) {
        if (!wantsJob(err)) throw err;
      }
      if (first !== null) {
        const read = await metaPagesFrom(c, accessToken, first, maxPages, limit);
        return { rows: read.rows.slice(0, maxRows), more: read.more || read.rows.length > maxRows };
      }
    }
    job = true;
    const rows = await metaJobRows<MetaRangeInsight>(c, accessToken, act, params, opts.pollMs ?? META_REPORT_JOB.pollMs, {
      // Checked for as long as the request's time allows (metaJobDone).
      polls: opts.polls ?? Number.POSITIVE_INFINITY,
      stillRunning: () => new AdsReportPendingError("Meta is still preparing this report"),
      maxPages,
      allowMore: true,
      limit,
    });
    return { rows: rows.rows.slice(0, maxRows), more: rows.more || rows.rows.length > maxRows };
  } catch (err) {
    // Meta refusing the status filter or the sort: the report still comes, without them. A range that
    // already went to a job goes straight to one again: its synchronous try would only time out again.
    if (extras && refusedParameter(err)) {
      logger.warn({ err, act, level }, "meta: a report parameter was refused; asking without the status filter and sort");
      return metaRangeRead(c, accessToken, accountId, level, since, until, maxRows, breakdown, opts, false, job);
    }
    throw err;
  }
}

/** The ad account's edge that lists each level's objects. */
const LEVEL_EDGE: Record<MetaReportLevel, string> = { campaign: "campaigns", adset: "adsets", ad: "ads" };
/** Pages of campaigns, ad sets or ads read at most for their statuses and settings (5,000). */
const STATUS_PAGES = 10;

/** What one level's list says of the objects asked about, and (campaigns) of the whole list. */
export interface MetaListing {
  /** By id: the delivery status (effective_status) and the settings of each object asked about that the list had. */
  objects: Map<string, { status: string; details: MetaObjectDetails }>;
  /** Campaigns, when counted: every campaign read, by state; null otherwise. */
  counts: MetaCampaignCounts | null;
}

/**
 * The delivery status (effective_status: ACTIVE, PAUSED, CAMPAIGN_PAUSED, WITH_ISSUES...) and settings
 * (objective, budget, schedule, bidding; an ad's preview) of campaigns / ad sets / ads by id, read from
 * the account's own list of them with every status asked for (archived and deleted ones are left out
 * otherwise), until every id is found or STATUS_PAGES pages are read. With `count` (campaigns), the
 * whole list is read, to STATUS_PAGES pages, and counted by state. Graph API v26.0 refuses the
 * multiple-id lookup (GET /?ids=) this used before, and every version does from 2026-10-27
 * (https://developers.facebook.com/docs/graph-api/changelog/version26.0); one list page also costs one
 * call where a lookup counted each id. A field list Meta refuses (code 100: a field this version
 * doesn't know) is asked again as the status alone; a page after the first that fails ends the look
 * with what was found so far. `deadline` as a live report's; `currency` for the budgets.
 */
export async function metaListed(
  c: MetaConfig,
  accessToken: string,
  accountId: string,
  level: MetaReportLevel,
  ids: string[],
  opts: { deadline?: number; currency?: string | null; count?: boolean } = {},
): Promise<MetaListing> {
  const objects: MetaListing["objects"] = new Map();
  const counts = level === "campaign" && opts.count ? noMetaCampaignCounts() : null;
  const wanted = new Set(ids.filter((id) => /^\d{1,30}$/.test(id)));
  if (!wanted.size && !counts) return { objects, counts };
  const act = metaAccountId(accountId);
  if (!/^act_\d{1,30}$/.test(act)) throw new AdsApiError(`Invalid Meta ad account ${accountId}`, 400);
  const limit = opts.deadline === undefined ? undefined : { deadline: opts.deadline };
  type Page = { data?: MetaListedObject[]; paging?: { next?: string } };
  const first = (fields: string) => metaGet<Page>(c, `${act}/${LEVEL_EDGE[level]}`, { fields, effective_status: JSON.stringify(EVERY_STATUS[level]), limit: "500" }, accessToken, limit);
  let page: Page;
  try {
    page = await first(META_OBJECT_FIELDS[level]);
  } catch (err) {
    if (!refusedParameter(err)) throw err;
    logger.warn({ err, act, level }, "meta: the settings fields were refused; reading delivery statuses alone");
    page = await first("id,effective_status");
  }
  const cut = (): MetaListing => {
    if (counts) counts.complete = false;
    return { objects, counts };
  };
  for (let i = 1; ; i++) {
    for (const o of page.data ?? []) {
      if (counts) metaCountCampaign(counts, o.effective_status);
      if (o.id && o.effective_status && wanted.has(o.id)) objects.set(o.id, { status: o.effective_status, details: metaObjectDetails(o, opts.currency) });
    }
    const next = page.paging?.next;
    if (!next) return { objects, counts };
    if (!counts && objects.size >= wanted.size) return { objects, counts };
    if (i >= STATUS_PAGES) return cut();
    try {
      page = await metaGet<Page>(c, next, {}, accessToken, limit);
    } catch (err) {
      logger.info({ err, act, level, found: objects.size, wanted: wanted.size }, "meta: the account's list read in part");
      return cut();
    }
  }
}

/** effective_status per campaign / ad set / ad id (metaListed, statuses only). */
export async function metaStatuses(c: MetaConfig, accessToken: string, accountId: string, level: MetaReportLevel, ids: string[], opts: { deadline?: number } = {}): Promise<Map<string, string>> {
  const { objects } = await metaListed(c, accessToken, accountId, level, ids, opts);
  return new Map([...objects].map(([id, o]) => [id, o.status]));
}

/** How many campaigns the account has in each state at Meta now (metaListed over the whole campaign list). */
export async function metaCampaignCounts(c: MetaConfig, accessToken: string, accountId: string, opts: { deadline?: number } = {}): Promise<MetaCampaignCounts> {
  return (await metaListed(c, accessToken, accountId, "campaign", [], { ...opts, count: true })).counts!;
}

/**
 * The device split is read with publisher_platform, the combination Meta documents impression_device
 * in (META_BREAKDOWN_PARAM), so it comes as one row per platform and device: here they are added up
 * into one row per device. Spend, impressions, clicks and each action's count and value add up; reach
 * and frequency count people, who may have seen the ads on several platforms, so a device made of more
 * than one row has them unknown.
 */
export function mergeMetaDeviceRows(rows: MetaRangeInsight[]): MetaRangeInsight[] {
  const byDevice = new Map<string, MetaRangeInsight[]>();
  for (const r of rows) {
    const device = r.impression_device ?? "unknown";
    byDevice.set(device, [...(byDevice.get(device) ?? []), r]);
  }
  const total = (list: MetaRangeInsight[], k: "spend" | "impressions" | "clicks" | "inline_link_clicks") => String(list.reduce((a, r) => a + (Number(r[k] ?? 0) || 0), 0));
  const actions = (list: MetaRangeInsight[], k: "actions" | "action_values") => {
    const by = new Map<string, number>();
    for (const r of list) for (const a of r[k] ?? []) by.set(a.action_type, (by.get(a.action_type) ?? 0) + (Number(a.value) || 0));
    return by.size ? [...by].map(([action_type, value]) => ({ action_type, value: String(value) })) : undefined;
  };
  return [...byDevice].map(([device, list]) => {
    if (list.length === 1) {
      const { publisher_platform: _platform, ...one } = list[0]!;
      return { ...one, impression_device: device };
    }
    return {
      impression_device: device,
      spend: total(list, "spend"),
      impressions: total(list, "impressions"),
      clicks: total(list, "clicks"),
      inline_link_clicks: total(list, "inline_link_clicks"),
      actions: actions(list, "actions"),
      action_values: actions(list, "action_values"),
      attribution_setting: list[0]!.attribution_setting,
    };
  });
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
  /** How many campaigns the account has in each state at Meta now (its whole list); null when not read. */
  campaigns: MetaCampaignCounts | null;
}

/**
 * By campaign, ad set or ad (with each one's delivery status and settings), or the whole account split
 * by placement, device, country, age or gender; with the account's campaigns counted by state.
 * Range-based: a comparison asks for its own range with a second call.
 */
export async function metaReport(
  c: MetaConfig,
  accessToken: string,
  accountId: string,
  level: MetaReportView,
  since: string,
  until: string,
  maxRows = 200,
  opts: MetaLiveReportOptions = {},
): Promise<MetaReport> {
  const breakdown = isMetaBreakdown(level) ? level : null;
  const live = { ...opts, deadline: opts.deadline ?? Date.now() + META_REPORT_JOB.budgetMs };
  const [account, raw] = await Promise.all([
    metaRangeRead(c, accessToken, accountId, "account", since, until, 2000, undefined, live),
    breakdown ? metaRangeRead(c, accessToken, accountId, "account", since, until, 2000, breakdown, live) : metaRangeRead(c, accessToken, accountId, level as MetaReportLevel, since, until, 2000, undefined, live),
  ]);
  const all = (breakdown === "device" ? mergeMetaDeviceRows(raw.rows) : raw.rows)
    .map((r) => (breakdown ? fromMetaBreakdownInsight(breakdown, r) : fromMetaRangeInsight(level as MetaReportLevel, r)))
    .sort((a, b) => b.spend - a.spend || b.impressions - a.impressions);
  const rows = all.slice(0, maxRows);
  let campaigns: MetaCampaignCounts | null = null;
  if (opts.statuses !== false) {
    // A status, a setting or a count that can't be read (an ad deleted since, no answer, no time left
    // for it) leaves that unknown, not the report broken: the numbers are the report. Meta refusing,
    // throttling, not answering, or no time left: unknown.
    const timeLeft = () => live.deadline - Date.now() >= META_REPORT_JOB.statusMs;
    const quiet = <T>(p: Promise<T>): Promise<T | null> =>
      p.catch((err: unknown) => {
        if (err instanceof AdsApiError || err instanceof AdsRetryableError) return null;
        throw err;
      });
    if (!breakdown) {
      const lvl = level as MetaReportLevel;
      const listing = timeLeft() ? await quiet(metaListed(c, accessToken, accountId, lvl, rows.map((r) => r.id), { deadline: live.deadline, currency: opts.currency, count: lvl === "campaign" })) : null;
      for (const r of rows) {
        const o = listing?.objects.get(r.id);
        r.status = o?.status ?? null;
        r.details = o?.details ?? null;
      }
      campaigns = listing?.counts ?? null;
    }
    // The campaign counts come with the campaign list; every other cut reads the list for them alone.
    if (level !== "campaign" && timeLeft()) campaigns = await quiet(metaCampaignCounts(c, accessToken, accountId, { deadline: live.deadline }));
  } else if (!breakdown) {
    for (const r of rows) {
      r.status = null;
      r.details = null;
    }
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
    campaigns,
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

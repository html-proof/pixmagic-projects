/**
 * Google Ads API: the accounts a login reaches (directly or under a manager account), daily numbers
 * per campaign, and the report by campaign, ad group, device or country, down to one campaign's ad
 * groups (or asset groups) and one ad group's ads. Read-only GAQL.
 */
import {
  AD_ERROR_OURS,
  fromGoogleAdsRow,
  googleAccountStatus,
  googleCustomerId,
  googleParentFits,
  googleReportRows,
  googleReportTotals,
  isDay,
  isGoogleObjectId,
  withGooglePurchases,
  type AdDayRow,
  type GoogleAdsRow,
  type GooglePurchaseRow,
  type GoogleReportApiRow,
  type GoogleReportLevel,
  type GoogleReportMetrics,
  type GoogleReportParent,
  type GoogleReportRow,
} from "@app/shared";
import { logger } from "../logger.js";
import {
  AD_DISCOVERY_BUDGET_MS,
  adAccountListWithin,
  AdsApiError,
  AdsAuthError,
  AdsNoAccountsError,
  AdsNotApprovedError,
  AdsPermissionError,
  AdsRateLimitedError,
  AdsRetryableError,
  AdsUnavailableError,
  googleCommonError,
  googleSetupError,
  readGoogleError,
  REQUIRED_AD_SCOPE,
  type AdAccount,
  type AdAccountHealth,
  type AdAccountList,
  type GoogleAdsFailureError,
  type GoogleApiError,
} from "./common.js";
import { googleConsentUrl, type GoogleConsentOptions, type GoogleOAuthClient } from "./googleOAuth.js";

/**
 * Google Ads API access follows the Cloud project that owns the OAuth client (Google retired developer
 * tokens on 2026-09-09), so the client and an API version are all a call needs.
 */
export interface GoogleConfig extends GoogleOAuthClient {
  /** Google Ads API version, e.g. "v25". */
  version: string;
}

export const GOOGLE_ADS_SCOPE = REQUIRED_AD_SCOPE.google;

export function googleAuthorizeUrl(c: GoogleConfig, redirectUri: string, state: string, codeChallenge?: string, opts?: GoogleConsentOptions): string {
  return googleConsentUrl(c, GOOGLE_ADS_SCOPE, redirectUri, state, codeChallenge, opts);
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
  const body: unknown = await res.json().catch(() => undefined);
  // searchStream answers a JSON array of batches. A failure after the answer began (a 200) comes as an
  // { error } element anywhere in it: the batches before it are only part of the answer.
  const isErr = (b: unknown): b is { error: unknown } => !!b && typeof b === "object" && "error" in b && !!(b as { error?: unknown }).error;
  const error = Array.isArray(body) ? body.find(isErr)?.error : isErr(body) ? body.error : undefined;
  if (res.ok && error === undefined) {
    // A 200 whose body can't be read (cut off mid-stream) is no answer, not an empty one.
    if (body === undefined) throw new AdsRetryableError("Google Ads' answer was cut off");
    return body as T;
  }
  const status = res.ok ? Number((error as { code?: unknown })?.code) || 500 : res.status;
  throw googleAdsError(c, readGoogleError(error, status, `Google Ads returned ${status}`));
}

/** bizinsights' own Cloud project's approval, not the merchant's account (Test access only, retired developer tokens...). */
const NOT_APPROVED = new Set([
  "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
  "DEVELOPER_TOKEN_NOT_APPROVED",
  "DEVELOPER_TOKEN_NOT_ON_ALLOWLIST",
  "DEVELOPER_TOKEN_PROHIBITED",
  "DEVELOPER_TOKEN_INVALID",
  "PROJECT_DISABLED",
  "ORGANIZATION_NOT_APPROVED",
  "ORGANIZATION_NOT_RECOGNIZED",
  "ORGANIZATION_NOT_ASSOCIATED_WITH_DEVELOPER_TOKEN",
  "CLOUD_PROJECT_NOT_UNDER_ORGANIZATION",
  "SERVICE_ACCESS_DENIED",
  "METRIC_ACCESS_DENIED",
]);
/** The sign-in itself ended (revoked, expired, the Google account deleted): connecting again fixes it. */
const AUTH_ENDED = new Set([
  "AUTHENTICATION_ERROR",
  "OAUTH_TOKEN_INVALID",
  "OAUTH_TOKEN_EXPIRED",
  "OAUTH_TOKEN_DISABLED",
  "OAUTH_TOKEN_REVOKED",
  "GOOGLE_ACCOUNT_DELETED",
  "GOOGLE_ACCOUNT_COOKIE_INVALID",
  "GOOGLE_ACCOUNT_AUTHENTICATION_FAILED",
  "GOOGLE_ACCOUNT_USER_AND_ADS_USER_MISMATCH",
]);
/**
 * This login can't read this account (any more): removed from it, the manager link gone, or the
 * account's admin now requires 2-Step Verification or Advanced Protection the login doesn't have.
 */
const NO_ACCESS = new Set([
  "USER_PERMISSION_DENIED",
  "INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION",
  "ACCESS_DENIED_FOR_ACCOUNT_TYPE",
  "TWO_STEP_VERIFICATION_NOT_ENROLLED",
  "ADVANCED_PROTECTION_NOT_ENROLLED",
]);

/**
 * Sort a Google Ads failure by its GoogleAdsFailure error codes (error.details[].errors[].errorCode),
 * not the wrapper's text: https://developers.google.com/google-ads/api/docs/get-started/common-errors
 * and the v25 AuthenticationError / AuthorizationError / QuotaError enums. The thrown error carries
 * Google's own message for that error, and its code (providerCode) for the logs.
 */
function googleAdsError(c: GoogleConfig, g: GoogleApiError): Error {
  const parts = (e: GoogleAdsFailureError) => {
    const [kind = "", value = ""] = (e.code ?? "").split(".");
    return { kind, value };
  };
  const find = (test: (kind: string, value: string) => boolean) => g.adsErrors.find((e) => test(parts(e).kind, parts(e).value));
  const tagged = <E extends Error & { providerCode?: string }>(err: E, e?: GoogleAdsFailureError): E => {
    const code = e?.code ?? g.adsErrors[0]?.code;
    if (code) err.providerCode = code;
    return err;
  };
  const say = (e?: GoogleAdsFailureError) => e?.message ?? g.adsErrors[0]?.message ?? g.message;

  // A Google login with no Google Ads account answers NOT_ADS_USER: that's "no accounts", not ended access.
  const notAdsUser = find((_k, v) => v === "NOT_ADS_USER");
  if (notAdsUser || /NOT_ADS_USER/.test(g.message)) return tagged(new AdsNoAccountsError(say(notAdsUser)), notAdsUser);
  // The Google Ads API switched off on bizinsights' project, or a token without the adwords permission.
  const setup = googleSetupError(g, say());
  if (setup) return tagged(setup);
  // v24 and earlier answered ACTION_NOT_PERMITTED where v25 says CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION.
  const legacyVersion = Number(/^v(\d+)/.exec(c.version)?.[1] ?? 99) < 25;
  const notApproved = find((_k, v) => NOT_APPROVED.has(v) || (legacyVersion && v === "ACTION_NOT_PERMITTED"));
  if (notApproved || /not approved for production/i.test(g.message)) return tagged(new AdsNotApprovedError(say(notApproved)), notApproved);
  const tos = find((_k, v) => v === "MISSING_TOS");
  if (tos) return tagged(new AdsApiError(say(tos), g.httpStatus, undefined, "not_configured"), tos);
  const ended = find((k, v) => k === "authenticationError" && AUTH_ENDED.has(v));
  if (ended) return tagged(new AdsAuthError(say(ended)), ended);
  const lost = find((_k, v) => NO_ACCESS.has(v) || v === "ACTION_NOT_PERMITTED");
  if (lost) return tagged(new AdsPermissionError(say(lost)), lost);
  // The account itself. Accounts bizinsights connected were readable then, so "not enabled" later means
  // Google deactivated or cancelled it; a half-set-up one in a sign-in's list is skipped before that.
  const state = find((_k, v) => ["CUSTOMER_NOT_FOUND", "CUSTOMER_NOT_ENABLED", "INCOMPLETE_SIGNUP", "ACTION_NOT_PERMITTED_FOR_SUSPENDED_ACCOUNT"].includes(v));
  if (state) {
    const v = parts(state).value;
    return tagged(new AdsUnavailableError(say(state), v === "INCOMPLETE_SIGNUP" ? "account_not_ready" : v === "ACTION_NOT_PERMITTED_FOR_SUSPENDED_ACCOUNT" ? "account_disabled" : "account_closed"), state);
  }
  const quota = find((k) => k === "quotaError");
  if (quota) {
    const q = quota.quota;
    const wait = q?.retryDelayS ?? g.retryAfterS;
    // RESOURCE_EXHAUSTED on the project's own bucket with a long (or no) wait is the daily operations
    // allowance (2,880 a day with Explorer access); a short wait, or the account's own bucket, is throttling.
    const daily = parts(quota).value === "RESOURCE_EXHAUSTED" && (wait === null || wait >= 3600) && (q?.rateScope === "DEVELOPER" || /\bday|daily/i.test(q?.rateName ?? ""));
    return tagged(new AdsRateLimitedError(say(quota), wait, daily ? "quota_exhausted" : "rate_limited"), quota);
  }
  const internal = find((k) => k === "internalError");
  if (internal) return tagged(new AdsRetryableError(say(internal)), internal);
  return tagged(googleCommonError(g, say()) ?? new AdsApiError(say(), g.httpStatus));
}

type SearchStream<R> = Array<{ results?: R[] }>;

async function googleSearch<R>(c: GoogleConfig, accessToken: string, customerId: string, query: string, loginCustomerId?: string | null): Promise<R[]> {
  const batches = await googleAds<SearchStream<R>>(c, accessToken, `customers/${googleCustomerId(customerId)}/googleAds:searchStream`, { method: "POST", body: { query }, loginCustomerId });
  if (!Array.isArray(batches)) throw new AdsApiError("Google Ads answered a search with something other than its batches", 502);
  return batches.flatMap((b) => b.results ?? []);
}

interface CustomerRow {
  customer?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean; status?: string };
}
interface CustomerClientRow {
  customerClient?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean; status?: string };
}

/** How many accessible customers one sign-in looks up, and how many at a time (it runs inside the OAuth callback). */
export const GOOGLE_DISCOVERY_MAX_CUSTOMERS = 300;
const GOOGLE_DISCOVERY_CONCURRENCY = 8;

/**
 * Run `task` over `items`, at most `limit` at a time, keeping the order. A task that throws stops
 * new ones starting; its error is thrown once the running ones are done. Past `deadline` (epoch ms)
 * no new one starts either, once the first `limit` have: those left out stay `undefined`.
 */
async function eachLimited<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>, deadline = Number.POSITIVE_INFINITY): Promise<Array<R | undefined>> {
  const out = new Array<R | undefined>(items.length).fill(undefined);
  const run = { next: 0, failed: false, err: undefined as unknown };
  const worker = async () => {
    while (!run.failed && run.next < items.length && (run.next < limit || Date.now() < deadline)) {
      const i = run.next++;
      try {
        out[i] = await task(items[i]!);
      } catch (err) {
        if (!run.failed) Object.assign(run, { failed: true, err });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (run.failed) throw run.err;
  return out;
}

/**
 * A failure that belongs to the sign-in or to bizinsights, not to one account in the list: it fails the
 * whole look-up. Anything else (an account cancelled, suspended, half set up, or this login removed
 * from it) only leaves that account out.
 */
const failsDiscovery = (err: unknown) =>
  !(err instanceof AdsApiError) || err instanceof AdsNotApprovedError || err instanceof AdsNoAccountsError || AD_ERROR_OURS.has(err.errorCode);

type Discovered = { kind: "direct"; account: AdAccount } | { kind: "manager"; clients: AdAccount[] } | { kind: "unreadable"; why: string };

/**
 * Every ad account the person can report on: the ones they reach directly, and the clients of
 * any manager account they reach (which need the manager's id on every call). Manager accounts
 * themselves have no metrics of their own and are never listed. Never empty: with nothing to
 * connect it throws AdsNoAccountsError, saying why, so the person is told what to do.
 *
 * Each accessible customer costs a query (a manager one more), and it all runs inside the OAuth
 * callback: the look-ups run 8 at a time, stop at GOOGLE_DISCOVERY_MAX_CUSTOMERS and at
 * AD_DISCOVERY_BUDGET_MS (`budgetMs`), and the list stops at what the sign-in can hold while the
 * person picks (AD_ACCOUNT_LIST_MAX_BYTES). A list cut by any of them is marked `truncated`.
 */
export async function googleAdAccounts(c: GoogleConfig, accessToken: string, opts: { budgetMs?: number } = {}): Promise<AdAccountList> {
  const list = await googleAds<{ resourceNames?: string[] }>(c, accessToken, "customers:listAccessibleCustomers", { method: "GET" });
  const deadline = Date.now() + (opts.budgetMs ?? AD_DISCOVERY_BUDGET_MS);
  const all = [...new Set((list.resourceNames ?? []).map((r) => googleCustomerId(r.split("/").pop() ?? "")).filter(Boolean))];
  if (!all.length) throw new AdsNoAccountsError("This Google login has no Google Ads account");
  const ids = all.slice(0, GOOGLE_DISCOVERY_MAX_CUSTOMERS);
  if (all.length > ids.length) {
    logger.warn({ accessible: all.length, checked: ids.length, dropped: all.slice(ids.length, ids.length + 20) }, "google ads: login reaches more customers than one sign-in looks up; the rest are left out");
  }
  const looked = await eachLimited(ids, GOOGLE_DISCOVERY_CONCURRENCY, async (id): Promise<Discovered> => {
    let me: CustomerRow["customer"];
    try {
      me = (await googleSearch<CustomerRow>(c, accessToken, id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer"))[0]?.customer;
    } catch (err) {
      // A cancelled, suspended or half-set-up account in the list: skip it rather than fail the connection.
      if (failsDiscovery(err)) throw err;
      return { kind: "unreadable", why: `${id}: ${(err as Error).message}` };
    }
    if (!me) return { kind: "unreadable", why: `${id}: no account details` };
    if (!me.manager) {
      const status = googleAccountStatus(me.status);
      return { kind: "direct", account: { accountId: id, name: me.descriptiveName ?? null, currency: me.currencyCode ?? null, timezone: me.timeZone ?? null, loginCustomerId: null, status } };
    }
    const clients = await googleSearch<CustomerClientRow>(
      c,
      accessToken,
      id,
      "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.manager = FALSE AND customer_client.status = 'ENABLED'",
      id,
    ).catch((err: unknown) => {
      if (failsDiscovery(err)) throw err;
      return [] as CustomerClientRow[];
    });
    const accounts: AdAccount[] = [];
    for (const cl of clients) {
      const cid = cl.customerClient?.id ? googleCustomerId(String(cl.customerClient.id)) : "";
      // Never a manager: only client accounts have metrics to report.
      if (!cid || cl.customerClient?.manager) continue;
      accounts.push({
        accountId: cid,
        name: cl.customerClient?.descriptiveName ?? null,
        currency: cl.customerClient?.currencyCode ?? null,
        timezone: cl.customerClient?.timeZone ?? null,
        loginCustomerId: id,
        status: googleAccountStatus(cl.customerClient?.status),
      });
    }
    return { kind: "manager", clients: accounts };
  }, deadline);
  const late = ids.filter((_, i) => looked[i] === undefined);
  if (late.length) {
    logger.warn({ checked: ids.length - late.length, late: late.length, dropped: late.slice(0, 20) }, "google ads: account look-ups ran out of the sign-in's time; the rest are left out");
  }
  const found = looked.filter((f): f is Discovered => f !== undefined);
  const out = new Map<string, AdAccount>();
  const unreadable: string[] = [];
  // In the order Google listed them: an account reached directly wins over the same one under a manager.
  for (const f of found) {
    if (f.kind === "unreadable") unreadable.push(f.why);
    else if (f.kind === "direct") out.set(f.account.accountId, f.account);
    else for (const a of f.clients) if (!out.has(a.accountId)) out.set(a.accountId, a);
  }
  if (out.size) {
    const listed = adAccountListWithin([...out.values()], all.length > ids.length || late.length > 0);
    if (listed.length < out.size) logger.warn({ found: out.size, listed: listed.length }, "google ads: more accounts than one sign-in can hold; the rest are left out");
    return listed;
  }
  // Nothing readable among the ones looked at in time: the others may be, so it's worth another go.
  if (late.length) throw new AdsRetryableError("Google Ads took too long to list this login's accounts");
  // Accounts exist but none can be read: unfinished or closed accounts first, since they're the person's own.
  if (unreadable.length) throw new AdsNoAccountsError(`Google Ads won't report on ${unreadable.slice(0, 20).join("; ")}`, "not_ready");
  throw new AdsNoAccountsError(`Only manager accounts with no active ad account under them: ${ids.slice(0, 20).join(", ")}`, "manager_only");
}

/**
 * Cost, impressions, clicks, conversions and their value per campaign per day, and the purchases
 * among those conversions.
 *
 * Google's metrics.conversions counts every conversion action included in "Conversions" (leads,
 * sign-ups, calls, purchases...). Purchases are the conversions of actions in the PURCHASE category,
 * which takes a second query: segments.conversion_action_category can only sit next to conversion
 * metrics (not cost or clicks), and a segment in WHERE must be in SELECT too
 * (https://developers.google.com/google-ads/api/docs/reporting/segmentation).
 */
export async function googleCampaignDays(c: GoogleConfig, accessToken: string, account: { accountId: string; loginCustomerId?: string | null }, since: string, until: string): Promise<AdDayRow[]> {
  // The days go into the query text: only ever real YYYY-MM-DD days.
  if (!isDay(since) || !isDay(until)) throw new AdsApiError(`Invalid date range ${since}..${until}`, 400);
  const during = `segments.date BETWEEN '${since}' AND '${until}'`;
  const rows = (
    await googleSearch<GoogleAdsRow>(
      c,
      accessToken,
      account.accountId,
      `SELECT campaign.id, campaign.name, campaign.status, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${during}`,
      account.loginCustomerId,
    )
  )
    .map((r) => fromGoogleAdsRow(googleCustomerId(account.accountId), r))
    .filter((r): r is AdDayRow => r !== null);
  // Purchases are a part of conversions: with none counted in the window there are none to ask for.
  if (!rows.some((r) => r.conversions !== 0)) return rows.map((r) => ({ ...r, purchases: 0, purchaseValue: 0 }));
  let purchases: GooglePurchaseRow[];
  try {
    purchases = await googleSearch<GooglePurchaseRow>(
      c,
      accessToken,
      account.accountId,
      `SELECT campaign.id, segments.date, segments.conversion_action_category, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${during} AND segments.conversion_action_category = 'PURCHASE'`,
      account.loginCustomerId,
    );
  } catch (err) {
    // Google refusing the query itself: the day's numbers still count, with purchases left unknown
    // (null) rather than the sync failed. Lost access, throttling and outages fail it as usual.
    if (err instanceof AdsApiError && err.status === 400 && err.errorCode === "provider_error") {
      logger.warn({ err, accountId: account.accountId }, "google ads: purchase query refused; purchases left unknown");
      return rows;
    }
    throw err;
  }
  return withGooglePurchases(rows, purchases);
}

export interface GoogleReport {
  level: GoogleReportLevel;
  since: string;
  until: string;
  /**
   * The whole account's totals for the range. Under a parent (a campaign's ad groups, an ad group's
   * ads): every row Google reported there added up, the ones past `maxRows` included.
   */
  totals: GoogleReportMetrics;
  /** Biggest spend first. */
  rows: GoogleReportRow[];
  /** More rows had spend than are listed. */
  truncated: boolean;
}

const GOOGLE_METRICS = "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value";

/**
 * A drill-down's parent, checked: a level it fits (googleParentFits), and Google's own ids, digits
 * only, since they go into the query text (as the dates do). Null for the whole account.
 */
function checkedParent(level: GoogleReportLevel, parent: GoogleReportParent): GoogleReportParent | null {
  if (!googleParentFits(level, parent)) throw new AdsApiError(`Google's ${level} report can't be read ${parent.campaign === undefined && parent.adGroup === undefined ? "for the whole account" : "under that campaign or ad group"}`, 400);
  if (![parent.campaign, parent.adGroup].every((id) => id === undefined || isGoogleObjectId(id))) throw new AdsApiError("Invalid Google Ads campaign or ad group id", 400);
  return parent.campaign === undefined && parent.adGroup === undefined ? null : parent;
}

/**
 * The query for each level. Without segments.date in SELECT, Google sums the metrics over the range.
 * Under a parent, only its rows: a campaign's ad groups, a Performance Max campaign's asset groups
 * (it has no ad groups: https://developers.google.com/google-ads/api/performance-max/asset-group-reporting),
 * an ad group's ads (their id, name, type and status; never their text or links).
 */
function googleReportQuery(level: GoogleReportLevel, since: string, until: string, parent: GoogleReportParent | null): string {
  const during = `segments.date BETWEEN '${since}' AND '${until}'`;
  const inCampaign = parent?.campaign !== undefined ? ` AND campaign.id = ${parent.campaign}` : "";
  const inAdGroup = parent?.adGroup !== undefined ? ` AND ad_group.id = ${parent.adGroup}` : "";
  switch (level) {
    case "campaign":
      return `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, ${GOOGLE_METRICS} FROM campaign WHERE ${during}`;
    case "ad_group":
      return `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status, ${GOOGLE_METRICS} FROM ad_group WHERE ${during}${inCampaign}`;
    case "asset_group":
      return `SELECT campaign.id, campaign.name, asset_group.id, asset_group.name, asset_group.status, ${GOOGLE_METRICS} FROM asset_group WHERE ${during}${inCampaign}`;
    case "ad":
      return `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status, ${GOOGLE_METRICS} FROM ad_group_ad WHERE ${during}${inCampaign}${inAdGroup}`;
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
 * the account's own totals. Read-only GAQL; dates and ids are validated before they go into the query.
 *
 * Under a parent (`parent`: one campaign's ad groups or asset groups, one ad group's ads) it is one
 * operation, not two: the account's totals aren't asked for, and the totals are the rows added up,
 * every one Google returned (the page says so: they are not the campaign's own row).
 */
export async function googleReport(
  c: GoogleConfig,
  accessToken: string,
  account: { accountId: string; loginCustomerId?: string | null },
  level: GoogleReportLevel,
  since: string,
  until: string,
  maxRows = 200,
  parent: GoogleReportParent = {},
): Promise<GoogleReport> {
  if (!isDay(since) || !isDay(until)) throw new AdsApiError(`Invalid date range ${since}..${until}`, 400);
  const drill = checkedParent(level, parent);
  const [totalRows, raw] = await Promise.all([
    drill ? null : googleSearch<GoogleReportApiRow>(c, accessToken, account.accountId, `SELECT ${GOOGLE_METRICS} FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`, account.loginCustomerId),
    googleSearch<GoogleReportApiRow>(c, accessToken, account.accountId, googleReportQuery(level, since, until, drill), account.loginCustomerId),
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
  // The account's totals row, or under a parent every row of it; none: nothing ran in the range, so zero.
  return { level, since, until, totals: googleReportTotals(totalRows ?? raw), rows, truncated: all.length > rows.length };
}

/**
 * One Google Ads account's health as Google reports it now: its customer status (normalized), name,
 * currency and time zone. One operation, made with the daily re-check.
 */
export async function googleAccountHealth(c: GoogleConfig, accessToken: string, account: { accountId: string; loginCustomerId?: string | null }): Promise<AdAccountHealth> {
  const me = (
    await googleSearch<{ customer?: { status?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string } }>(
      c,
      accessToken,
      account.accountId,
      "SELECT customer.status, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer",
      account.loginCustomerId,
    )
  )[0]?.customer;
  return { status: googleAccountStatus(me?.status), detail: null, name: me?.descriptiveName ?? null, currency: me?.currencyCode ?? null, timezone: me?.timeZone ?? null };
}

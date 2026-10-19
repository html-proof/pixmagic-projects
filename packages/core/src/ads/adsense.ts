/**
 * AdSense Management API: what the site earns from Google ads shown on it, per site per day.
 */
import {
  ADSENSE_REPORT_DIMENSIONS,
  ADSENSE_REPORT_METRICS,
  adsenseAccountId,
  adsenseAccountStatus,
  adsenseReportRows,
  adsenseReportTotals,
  fromAdsenseReport,
  isDay,
  type AdsenseDayRow,
  type AdsenseReport,
  type AdsenseReportLevel,
  type AdsenseReportRow,
  type AdsenseTotals,
} from "@app/shared";
import { AdsApiError, AdsNoAccountsError, AdsPermissionError, googleCommonError, readGoogleError, REQUIRED_AD_SCOPE, type AdAccount, type AdAccountHealth } from "./common.js";
import { googleConsentUrl, type GoogleConsentOptions, type GoogleOAuthClient } from "./googleOAuth.js";

/** AdSense needs only the Google OAuth client (and the AdSense Management API on its project). */
export type AdsenseConfig = GoogleOAuthClient;

export const ADSENSE_SCOPE = REQUIRED_AD_SCOPE.adsense;

export function adsenseAuthorizeUrl(c: AdsenseConfig, redirectUri: string, state: string, codeChallenge?: string, opts?: GoogleConsentOptions): string {
  return googleConsentUrl(c, ADSENSE_SCOPE, redirectUri, state, codeChallenge, opts);
}

/**
 * GET from the AdSense Management API v2. A failure is sorted by Google's error details, not only its
 * status: the API switched off on bizinsights' project (SERVICE_DISABLED: ours to fix), a token
 * without adsense.readonly (ACCESS_TOKEN_SCOPE_INSUFFICIENT: connect again), and PERMISSION_DENIED on
 * an account (this login can no longer read it) each say something different to the merchant.
 */
async function adsenseGet<T>(c: AdsenseConfig, accessToken: string, path: string, params: URLSearchParams): Promise<T> {
  const query = params.toString();
  const res = await (c.fetchImpl ?? fetch)(`https://adsense.googleapis.com/v2/${path}${query ? `?${query}` : ""}`, { method: "GET", headers: { authorization: `Bearer ${accessToken}` } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: unknown };
  if (res.ok && !body.error) return body;
  const g = readGoogleError(body.error, res.status, `AdSense returned ${res.status}`);
  const common = googleCommonError(g, g.message);
  if (common) throw common;
  if (res.status === 403 || g.status === "PERMISSION_DENIED") {
    // A Google login with no AdSense account at all answers the account list with a 403, not an empty list.
    if (path === "accounts") throw /adsense account/i.test(g.message) ? new AdsNoAccountsError(g.message) : new AdsPermissionError(g.message);
    if (path.startsWith("accounts/")) throw new AdsPermissionError(g.message);
  }
  throw new AdsApiError(g.message, res.status);
}

interface AdsenseAccount {
  name?: string;
  displayName?: string;
  timeZone?: { id?: string };
  /** READY, NEEDS_ATTENTION or CLOSED. */
  state?: string;
  /** Sign-up tasks left, e.g. "phone-pin-verification". */
  pendingTasks?: string[];
}

/** "phone-pin-verification" → "phone pin verification". */
const taskWords = (tasks: string[]) => tasks.map((t) => t.replace(/[-_]+/g, " ").trim()).filter(Boolean);

/** An account's state (READY, NEEDS_ATTENTION) and sign-up tasks left, as an ad account's status and its detail. */
function accountState(a: AdsenseAccount): Pick<AdAccount, "status" | "statusDetail"> {
  const tasks = taskWords(a.pendingTasks ?? []);
  return { status: adsenseAccountStatus(a.state, tasks), statusDetail: tasks.length ? `Still to do in AdSense: ${tasks.join(", ")}` : null };
}

/**
 * The AdSense accounts the person can read, with their state (an account whose sign-up isn't
 * finished, or that needs attention, says so); closed ones are left out. The account doesn't say
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
      out.push({ accountId: adsenseAccountId(a.name), name: a.displayName ?? null, currency: null, timezone: a.timeZone?.id ?? null, ...accountState(a) });
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
 * Estimated earnings, page views, impressions and clicks per site per day, from `since` to `until`,
 * on the account's own calendar. AdSense's IMPRESSIONS counts ad requests that showed at least one
 * ad, not each ad shown (that is INDIVIDUAL_AD_IMPRESSIONS, "Ads shown" in AdSense):
 * https://developers.google.com/adsense/management/reference/rest/v2/Metric. Asked for by site; if
 * AdSense won't split this account's report that way, the account's daily totals are fetched
 * instead (site "").
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

/** "pub-123" or "accounts/pub-123" → "pub-123", or an error: the id goes into the URL path. */
function publisherId(accountId: string): string {
  const pub = adsenseAccountId(accountId);
  if (!/^pub-\d+$/.test(pub)) throw new AdsApiError(`Invalid AdSense account ${accountId}`, 400);
  return pub;
}

/**
 * One AdSense account's health as AdSense reports it now: its state (normalized, with any sign-up
 * tasks left), name and time zone. One cheap call, made with the daily re-check.
 */
export async function adsenseAccountHealth(c: AdsenseConfig, accessToken: string, accountId: string): Promise<AdAccountHealth> {
  const pub = publisherId(accountId);
  const a = await adsenseGet<AdsenseAccount>(c, accessToken, `accounts/${pub}`, new URLSearchParams());
  const state = accountState(a);
  return {
    status: state.status ?? null,
    detail: state.statusDetail ?? null,
    name: a.displayName ?? null,
    // AdSense says the currency only in reports.
    currency: null,
    timezone: a.timeZone?.id ?? null,
  };
}

/** At most this many rows of an AdSense report are read (biggest earners first). */
export const ADSENSE_REPORT_MAX_ROWS = 1000;

/**
 * The AdSense report for one account and range, by site, country or device type, on the account's own
 * calendar. `sites` (DOMAIN_CODE values) limits it to the store's sites; empty means every site.
 * `truncated`: AdSense matched more rows than were read (only the biggest earners are listed).
 * `totals`: the whole report's, the rows left out of a cut-off one included (AdSense's totals row).
 */
export async function adsenseReport(
  c: AdsenseConfig,
  accessToken: string,
  accountId: string,
  level: AdsenseReportLevel,
  since: string,
  until: string,
  sites: readonly string[] = [],
): Promise<{ rows: AdsenseReportRow[]; currency: string | null; truncated: boolean; totals: AdsenseTotals }> {
  if (!isDay(since) || !isDay(until)) throw new AdsApiError(`Invalid date range ${since}..${until}`, 400);
  const pub = publisherId(accountId);
  // AdSense filters (https://developers.google.com/adsense/management/reporting/filtering):
  // "DOMAIN_CODE==a.com,DOMAIN_CODE==b.com", a comma meaning OR; a comma or backslash inside a value
  // would need escaping, so only plain host names go in.
  const hosts = sites.filter((h) => /^[a-z0-9.-]{1,253}$/i.test(h));
  // The store has sites, none of them a host AdSense could match: nothing of the account's is theirs.
  // Never every site instead, which would show other sites' earnings as the store's.
  if (sites.length && !hosts.length) return { rows: [], currency: null, truncated: false, totals: adsenseReportTotals({}, []) };
  const q = new URLSearchParams([
    ["dateRange", "CUSTOM"],
    ...dateParams("startDate", since),
    ...dateParams("endDate", until),
    ...ADSENSE_REPORT_DIMENSIONS[level].map((d): [string, string] => ["dimensions", d]),
    ...ADSENSE_REPORT_METRICS.map((m): [string, string] => ["metrics", m]),
    // Biggest earners first, so a cut-off report keeps the rows that matter.
    ["orderBy", "-ESTIMATED_EARNINGS"],
    ["reportingTimeZone", "ACCOUNT_TIME_ZONE"],
    ["limit", String(ADSENSE_REPORT_MAX_ROWS)],
  ]);
  if (hosts.length) q.append("filters", hosts.map((h) => `DOMAIN_CODE==${h}`).join(","));
  const report = await adsenseGet<AdsenseReport & { totalMatchedRows?: string }>(c, accessToken, `accounts/${pub}/reports:generate`, q);
  // "Reports producing more rows than the requested limit will be truncated", told by totalMatchedRows.
  const matched = Number(report.totalMatchedRows ?? 0);
  const { rows, currency } = adsenseReportRows(level, report);
  return { rows, currency, truncated: Number.isFinite(matched) && matched > (report.rows?.length ?? 0), totals: adsenseReportTotals(report, rows) };
}

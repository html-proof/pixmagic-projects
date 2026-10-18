/**
 * AdSense Management API: what the site earns from Google ads shown on it, per site per day.
 */
import {
  ADSENSE_REPORT_DIMENSIONS,
  ADSENSE_REPORT_METRICS,
  adsenseAccountId,
  adsenseAccountStatus,
  adsenseReportRows,
  fromAdsenseReport,
  isDay,
  type AdsenseDayRow,
  type AdsenseReport,
  type AdsenseReportLevel,
  type AdsenseReportRow,
} from "@app/shared";
import { AdsApiError, AdsAuthError, AdsRetryableError, REQUIRED_AD_SCOPE, type AdAccount, type AdAccountHealth } from "./common.js";
import { googleConsentUrl, type GoogleOAuthClient } from "./googleOAuth.js";

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
  /** READY, NEEDS_ATTENTION or CLOSED. */
  state?: string;
  /** Sign-up tasks left, e.g. "phone-pin-verification". */
  pendingTasks?: string[];
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

/** "pub-123" or "accounts/pub-123" → "pub-123", or an error: the id goes into the URL path. */
function publisherId(accountId: string): string {
  const pub = adsenseAccountId(accountId);
  if (!/^pub-\d+$/.test(pub)) throw new AdsApiError(`Invalid AdSense account ${accountId}`, 400);
  return pub;
}

/** "phone-pin-verification" → "phone pin verification". */
const taskWords = (tasks: string[]) => tasks.map((t) => t.replace(/[-_]+/g, " ").trim()).filter(Boolean);

/**
 * One AdSense account's health as AdSense reports it now: its state (normalized, with any sign-up
 * tasks left), name and time zone. One cheap call, made with the daily re-check.
 */
export async function adsenseAccountHealth(c: AdsenseConfig, accessToken: string, accountId: string): Promise<AdAccountHealth> {
  const pub = publisherId(accountId);
  const a = await adsenseGet<AdsenseAccount>(c, accessToken, `accounts/${pub}`, new URLSearchParams());
  const tasks = taskWords(a.pendingTasks ?? []);
  return {
    status: adsenseAccountStatus(a.state, tasks),
    detail: tasks.length ? `Still to do in AdSense: ${tasks.join(", ")}` : null,
    name: a.displayName ?? null,
    // AdSense says the currency only in reports.
    currency: null,
    timezone: a.timeZone?.id ?? null,
  };
}

/**
 * The AdSense report for one account and range, by site, country or device type, on the account's own
 * calendar. `sites` (DOMAIN_CODE values) limits it to the store's sites; empty means every site.
 */
export async function adsenseReport(
  c: AdsenseConfig,
  accessToken: string,
  accountId: string,
  level: AdsenseReportLevel,
  since: string,
  until: string,
  sites: readonly string[] = [],
): Promise<{ rows: AdsenseReportRow[]; currency: string | null }> {
  if (!isDay(since) || !isDay(until)) throw new AdsApiError(`Invalid date range ${since}..${until}`, 400);
  const pub = publisherId(accountId);
  const q = new URLSearchParams([
    ["dateRange", "CUSTOM"],
    ...dateParams("startDate", since),
    ...dateParams("endDate", until),
    ...ADSENSE_REPORT_DIMENSIONS[level].map((d): [string, string] => ["dimensions", d]),
    ...ADSENSE_REPORT_METRICS.map((m): [string, string] => ["metrics", m]),
    ["reportingTimeZone", "ACCOUNT_TIME_ZONE"],
    ["limit", "1000"],
  ]);
  // AdSense filters: "DOMAIN_CODE==a.com,DOMAIN_CODE==b.com" (a comma means OR). Only plain host names go in.
  const hosts = sites.filter((h) => /^[a-z0-9.-]{1,253}$/i.test(h));
  if (hosts.length) q.append("filters", hosts.map((h) => `DOMAIN_CODE==${h}`).join(","));
  const report = await adsenseGet<AdsenseReport>(c, accessToken, `accounts/${pub}/reports:generate`, q);
  return adsenseReportRows(level, report);
}

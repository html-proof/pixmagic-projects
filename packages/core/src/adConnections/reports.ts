/**
 * The live Meta, Google Ads and AdSense reports for one connection (the Marketing page's tables), asked
 * of the platform for exactly one date range: a comparison asks for its own range with a second call.
 */
import type { AdConnection } from "@app/db";
import type { AdProvider, AdsenseReportLevel, AdsenseReportRow, AdsenseTotals, GoogleReportLevel, MetaReportView } from "@app/shared";
import {
  AdsApiError,
  AdsRateLimitedError,
  AdsRetryableError,
  adsenseReport,
  classifyAdError,
  googleReport,
  META_REPORT_JOB,
  metaClassifyPermissionError,
  metaReport,
  type GoogleReport,
  type MetaReport,
} from "../ads.js";
import { googleAdsSource, isDemoConnection } from "../ads/googleAdsSource.js";
import type { Coord } from "../coord.js";
import { fetchUntil } from "../http.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { countGoogleAdsOperations, countingGoogleAdsFetch, googleAdsPaused, isMetaAppLimit, metaAdsPausedUntil, pauseGoogleAds, pauseMetaAds } from "./budget.js";
import { AD_PROVIDER_NAME, adsenseConfig, googleClient, metaConfig } from "./config.js";
import { adAccessToken } from "./credentials.js";
import { recordAdFailure } from "./status.js";

/**
 * How long a Google Ads or AdSense live report's calls may take in all (the token refresh included),
 * so the answer comes within the API's time limit: as long as Meta's reads get (META_REPORT_JOB).
 * A request that asks for two ranges (a comparison) passes one deadline to both.
 */
export const AD_REPORT_BUDGET_MS = META_REPORT_JOB.budgetMs;

/** Every call of one live report within its deadline; one cut off says the platform is busy (503, try again in a minute). */
const reportFetch = (provider: AdProvider, fetchImpl: FetchLike | undefined, deadline: number | undefined) =>
  fetchUntil(fetchImpl, deadline ?? Date.now() + AD_REPORT_BUDGET_MS, () => new AdsRetryableError(`${AD_PROVIDER_NAME[provider]} didn't answer in time`));

/** The platform isn't set up on this server: bizinsights' to fix, and nothing to record on the connection. */
const notSetUp = (provider: AdProvider) => new AdsApiError(`${AD_PROVIDER_NAME[provider]} isn't set up on this server`, 503, undefined, "not_configured");

/**
 * Run one live report, leaving what a failure says on its connection the way a sync would: access
 * ended or lost, or the account gone, marks it, so the dashboard stops presenting its numbers as
 * current; a rate limit or an outage says nothing about the stored days and leaves it as it is
 * (recordAdFailure). The error is thrown on for the route to word.
 */
async function liveReport<T>(conn: AdConnection, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    // Recording is best effort: the person is owed the report's own error, not the database's.
    await recordAdFailure(conn.id, classifyAdError(err), "report").catch((dbErr: unknown) => logger.warn({ err: dbErr, connectionId: conn.id }, "ad report failure not recorded"));
    throw err;
  }
}

/** Meta Ads is paused for Meta's limit on bizinsights' app: no call is made until it ends (`seconds` from now). */
const metaAppLimitReached = (seconds: number) => new AdsRateLimitedError("Meta Ads calls are paused: bizinsights' app is over Meta's request limit", seconds, "rate_limited");

/**
 * The Meta Ads report for one connected account and range, straight from Meta. A permission error
 * says whether ads_read was taken back (reconnect) or this login lost the account (permission).
 * `opts.deadline` (epoch ms): when Meta's reads must be done; by default META_REPORT_JOB.budgetMs from
 * now. A request that asks for two ranges (a comparison) passes one deadline to both, so together they
 * still fit the request's time; the comparison's range is read without delivery statuses
 * (`statuses: false`), which only the report's own rows show. With `coord`, Meta isn't asked at all while
 * Meta Ads is paused for Meta's limit on bizinsights' app (the answer is an AdsRateLimitedError, as Meta's
 * own throttling is), and Meta saying the app is over it pauses the syncs too.
 */
export async function metaReportForConnection(
  conn: AdConnection,
  level: MetaReportView,
  since: string,
  until: string,
  fetchImpl?: FetchLike,
  opts: { coord?: Coord; deadline?: number; statuses?: boolean } = {},
): Promise<MetaReport> {
  const cfg = metaConfig(fetchImpl);
  if (!cfg) throw notSetUp("meta");
  const paused = opts.coord ? await metaAdsPausedUntil(opts.coord) : null;
  if (paused) throw metaAppLimitReached(Math.ceil((paused.getTime() - Date.now()) / 1000));
  const deadline = opts.deadline ?? Date.now() + META_REPORT_JOB.budgetMs;
  try {
    return await liveReport(conn, async () => {
      const token = await adAccessToken(conn, fetchImpl);
      try {
        return await metaReport(cfg, token, conn.accountId, level, since, until, undefined, { deadline, currency: conn.currency, ...(opts.statuses === false ? { statuses: false } : {}) });
      } catch (err) {
        throw await metaClassifyPermissionError(cfg, token, err);
      }
    });
  } catch (err) {
    if (opts.coord && isMetaAppLimit(err)) await pauseMetaAds(opts.coord, err.retryAfterS);
    throw err;
  }
}

/** bizinsights has used the day's Google Ads API operations: no call is made until Google's allowance comes back. */
const googleAllowanceUsed = () => new AdsRateLimitedError("Google Ads API operations used up for today", null, "quota_exhausted");

/**
 * The Google Ads report for one connected account and range, straight from Google. Accounts already
 * connected keep their reports whether or not new connections are offered (googleClient). With `coord`,
 * its operations count against bizinsights' daily allowance like a sync's, none are made while Google
 * Ads syncs are paused for it, and Google saying the allowance is used up pauses them. Its calls end by
 * `opts.deadline` (default AD_REPORT_BUDGET_MS from now); one cut off is an AdsRetryableError.
 */
export async function googleReportForConnection(
  conn: AdConnection,
  level: GoogleReportLevel,
  since: string,
  until: string,
  fetchImpl?: FetchLike,
  opts: { coord?: Coord; deadline?: number } = {},
): Promise<GoogleReport> {
  // A demo's report is generated, not fetched: no client, no token, none of Google's operations spent.
  if (isDemoConnection(conn)) return liveReport(conn, () => googleAdsSource(conn, { cfg: null, accessToken: "" }).report(level, since, until));
  const cfg = googleClient(fetchImpl);
  if (!cfg) throw notSetUp("google");
  if (opts.coord && (await googleAdsPaused(opts.coord))) throw googleAllowanceUsed();
  const f = reportFetch("google", fetchImpl, opts.deadline);
  // Counted whatever happens, a call cut off by the deadline included (Google may have run it).
  const counter = countingGoogleAdsFetch(f);
  try {
    return await liveReport(conn, async () => googleReport({ ...cfg, fetchImpl: counter.fetchImpl }, await adAccessToken(conn, f), conn, level, since, until));
  } catch (err) {
    if (opts.coord && err instanceof AdsRateLimitedError && err.errorCode === "quota_exhausted") await pauseGoogleAds(opts.coord, err.retryAfterS).catch(() => undefined);
    throw err;
  } finally {
    if (opts.coord) await countGoogleAdsOperations(opts.coord, counter.operations());
  }
}

export interface AdsenseLiveReport {
  level: AdsenseReportLevel;
  since: string;
  until: string;
  /** The currency the earnings are in (the report's, else the one the sync learnt). */
  currency: string | null;
  /** Biggest earner first. */
  rows: AdsenseReportRow[];
  /** The whole range's totals, the rows a cut-off report leaves out included. */
  totals: AdsenseTotals;
  /** AdSense matched more rows than were read: only the biggest earners are listed. */
  truncated: boolean;
  /** The sites (DOMAIN_CODE) the report was limited to: the connection's; empty means every site. */
  sites: string[];
}

/**
 * The AdSense report for one connected account and range, by site, country or device type, straight
 * from AdSense and limited to the store's own sites (the connection's `sites`; empty: every site). An
 * account AdSense won't filter by site fails rather than answer with every site's earnings.
 */
export async function adsenseReportForConnection(
  conn: AdConnection,
  level: AdsenseReportLevel,
  since: string,
  until: string,
  fetchImpl?: FetchLike,
  opts: { deadline?: number } = {},
): Promise<AdsenseLiveReport> {
  const f = reportFetch("adsense", fetchImpl, opts.deadline);
  const cfg = adsenseConfig(f);
  if (!cfg) throw notSetUp("adsense");
  const sites = conn.sites ?? [];
  return liveReport(conn, async () => {
    const r = await adsenseReport(cfg, await adAccessToken(conn, f), conn.accountId, level, since, until, sites);
    return { level, since, until, currency: r.currency ?? conn.currency, rows: r.rows, totals: r.totals, truncated: r.truncated, sites };
  });
}

/**
 * The live Meta, Google Ads and AdSense reports for one connection (the Marketing page's tables), asked
 * of the platform for exactly one date range: a comparison asks for its own range with a second call.
 */
import type { AdConnection } from "@app/db";
import type { AdProvider, AdsenseReportLevel, AdsenseReportRow, AdsenseTotals, GoogleReportLevel, MetaReportView } from "@app/shared";
import {
  AdsApiError,
  AdsRateLimitedError,
  adsenseReport,
  classifyAdError,
  googleReport,
  META_REPORT_JOB,
  metaClassifyPermissionError,
  metaReport,
  type GoogleReport,
  type MetaReport,
} from "../ads.js";
import type { Coord } from "../coord.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { countGoogleAdsOperations, countingGoogleAdsFetch, googleAdsPaused, pauseGoogleAds } from "./budget.js";
import { AD_PROVIDER_NAME, adsenseConfig, googleClient, metaConfig } from "./config.js";
import { adAccessToken } from "./credentials.js";
import { recordAdFailure } from "./status.js";

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

/**
 * The Meta Ads report for one connected account and range, straight from Meta. A permission error
 * says whether ads_read was taken back (reconnect) or this login lost the account (permission).
 * `opts.deadline` (epoch ms): when Meta's reads must be done; by default META_REPORT_JOB.budgetMs from
 * now. A request that asks for two ranges (a comparison) passes one deadline to both, so together they
 * still fit the request's time.
 */
export async function metaReportForConnection(conn: AdConnection, level: MetaReportView, since: string, until: string, fetchImpl?: FetchLike, opts: { deadline?: number } = {}): Promise<MetaReport> {
  const cfg = metaConfig(fetchImpl);
  if (!cfg) throw notSetUp("meta");
  const deadline = opts.deadline ?? Date.now() + META_REPORT_JOB.budgetMs;
  return liveReport(conn, async () => {
    const token = await adAccessToken(conn, fetchImpl);
    try {
      return await metaReport(cfg, token, conn.accountId, level, since, until, undefined, { deadline });
    } catch (err) {
      throw await metaClassifyPermissionError(cfg, token, err);
    }
  });
}

/** bizinsights has used the day's Google Ads API operations: no call is made until Google's allowance comes back. */
const googleAllowanceUsed = () => new AdsRateLimitedError("Google Ads API operations used up for today", null, "quota_exhausted");

/**
 * The Google Ads report for one connected account and range, straight from Google. Accounts already
 * connected keep their reports whether or not new connections are offered (googleClient). With `coord`,
 * its operations count against bizinsights' daily allowance like a sync's, none are made while Google
 * Ads syncs are paused for it, and Google saying the allowance is used up pauses them.
 */
export async function googleReportForConnection(
  conn: AdConnection,
  level: GoogleReportLevel,
  since: string,
  until: string,
  fetchImpl?: FetchLike,
  opts: { coord?: Coord } = {},
): Promise<GoogleReport> {
  const cfg = googleClient(fetchImpl);
  if (!cfg) throw notSetUp("google");
  if (opts.coord && (await googleAdsPaused(opts.coord))) throw googleAllowanceUsed();
  const counter = countingGoogleAdsFetch(fetchImpl);
  try {
    return await liveReport(conn, async () => googleReport({ ...cfg, fetchImpl: counter.fetchImpl }, await adAccessToken(conn, fetchImpl), conn, level, since, until));
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
export async function adsenseReportForConnection(conn: AdConnection, level: AdsenseReportLevel, since: string, until: string, fetchImpl?: FetchLike): Promise<AdsenseLiveReport> {
  const cfg = adsenseConfig(fetchImpl);
  if (!cfg) throw notSetUp("adsense");
  const sites = conn.sites ?? [];
  return liveReport(conn, async () => {
    const r = await adsenseReport(cfg, await adAccessToken(conn, fetchImpl), conn.accountId, level, since, until, sites);
    return { level, since, until, currency: r.currency ?? conn.currency, rows: r.rows, totals: r.totals, truncated: r.truncated, sites };
  });
}

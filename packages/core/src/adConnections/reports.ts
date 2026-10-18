/**
 * The live Meta, Google Ads and AdSense reports for one connection (the Marketing page's tables), asked
 * of the platform for exactly one date range: a comparison asks for its own range with a second call.
 */
import type { AdConnection } from "@app/db";
import type { AdProvider, AdsenseReportLevel, AdsenseReportRow, GoogleReportLevel, MetaReportView } from "@app/shared";
import { AdsApiError, adsenseReport, classifyAdError, googleReport, metaClassifyPermissionError, metaReport, type GoogleReport, type MetaReport } from "../ads.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { AD_PROVIDER_NAME, adsenseConfig, googleConfig, metaConfig } from "./config.js";
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
 */
export async function metaReportForConnection(conn: AdConnection, level: MetaReportView, since: string, until: string, fetchImpl?: FetchLike): Promise<MetaReport> {
  const cfg = metaConfig(fetchImpl);
  if (!cfg) throw notSetUp("meta");
  return liveReport(conn, async () => {
    const token = await adAccessToken(conn, fetchImpl);
    try {
      return await metaReport(cfg, token, conn.accountId, level, since, until);
    } catch (err) {
      throw await metaClassifyPermissionError(cfg, token, err);
    }
  });
}

/** The Google Ads report for one connected account and range, straight from Google. */
export async function googleReportForConnection(conn: AdConnection, level: GoogleReportLevel, since: string, until: string, fetchImpl?: FetchLike): Promise<GoogleReport> {
  const cfg = googleConfig(fetchImpl);
  if (!cfg) throw notSetUp("google");
  return liveReport(conn, async () => googleReport(cfg, await adAccessToken(conn, fetchImpl), conn, level, since, until));
}

export interface AdsenseLiveReport {
  level: AdsenseReportLevel;
  since: string;
  until: string;
  /** The currency the earnings are in (the report's, else the one the sync learnt). */
  currency: string | null;
  /** Biggest earner first. */
  rows: AdsenseReportRow[];
  /** AdSense matched more rows than were read: only the biggest earners are listed. */
  truncated: boolean;
}

/**
 * The AdSense report for one connected account and range, by site, country or device type, straight
 * from AdSense and limited to the store's own sites (the connection's `sites`; empty: every site).
 */
export async function adsenseReportForConnection(conn: AdConnection, level: AdsenseReportLevel, since: string, until: string, fetchImpl?: FetchLike): Promise<AdsenseLiveReport> {
  const cfg = adsenseConfig(fetchImpl);
  if (!cfg) throw notSetUp("adsense");
  return liveReport(conn, async () => {
    const r = await adsenseReport(cfg, await adAccessToken(conn, fetchImpl), conn.accountId, level, since, until, conn.sites ?? []);
    return { level, since, until, currency: r.currency ?? conn.currency, rows: r.rows, truncated: r.truncated };
  });
}

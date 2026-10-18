/** The live Meta and Google Ads reports for one connection (the Marketing page's tables). */
import { systemDb, type AdConnection } from "@app/db";
import type { GoogleReportLevel, MetaReportView } from "@app/shared";
import { AdsApiError, AdsAuthError, googleReport, isMetaPermissionError, metaGrantedPermissions, metaReport, type GoogleReport, type MetaReport } from "../ads.js";
import type { FetchLike } from "../shopify.js";
import { googleConfig, metaConfig } from "./config.js";
import { adAccessToken } from "./credentials.js";

/**
 * The Meta Ads report for one connected account and range, straight from Meta. Lost access
 * (expired, revoked, ads_read taken back) marks the connection "reconnect", as a sync would, so
 * the dashboard stops presenting its numbers as current.
 */
export async function metaReportForConnection(conn: AdConnection, level: MetaReportView, since: string, until: string, fetchImpl?: FetchLike): Promise<MetaReport> {
  const cfg = metaConfig(fetchImpl);
  if (!cfg) throw new AdsApiError("Meta isn't set up on this server", 503);
  try {
    const token = await adAccessToken(conn, fetchImpl);
    try {
      return await metaReport(cfg, token, conn.accountId, level, since, until);
    } catch (err) {
      if (isMetaPermissionError(err)) {
        const granted = await metaGrantedPermissions(cfg, token).catch(() => null);
        if (granted && !granted.includes("ads_read")) throw new AdsAuthError("Meta's ads_read permission was taken back");
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof AdsAuthError) {
      await systemDb.adConnection.update({ where: { id: conn.id }, data: { status: "reconnect", lastError: err.message.slice(0, 500) } });
    }
    throw err;
  }
}

/**
 * The Google Ads report for one connected account and range, straight from Google. Lost access
 * (revoked, expired refresh token) marks the connection "reconnect", as a sync would.
 */
export async function googleReportForConnection(conn: AdConnection, level: GoogleReportLevel, since: string, until: string, fetchImpl?: FetchLike): Promise<GoogleReport> {
  const cfg = googleConfig(fetchImpl);
  if (!cfg) throw new AdsApiError("Google Ads isn't set up on this server", 503);
  try {
    const token = await adAccessToken(conn, fetchImpl);
    return await googleReport(cfg, token, conn, level, since, until);
  } catch (err) {
    if (err instanceof AdsAuthError) {
      await systemDb.adConnection.update({ where: { id: conn.id }, data: { status: "reconnect", lastError: err.message.slice(0, 500) } });
    }
    throw err;
  }
}

/** Syncing a connection: what the platform reports per day into ad_campaign_daily / adsense_daily, and the queue jobs that ask for it. */
import { systemDb, type AdConnection } from "@app/db";
import { addDays, localDay, type AdDayRow, type AdsenseDayRow } from "@app/shared";
import { AdsApiError, AdsAuthError, adsenseSiteDays, googleCampaignDays, isMetaPermissionError, metaCampaignDays, metaGrantedPermissions } from "../ads.js";
import type { Producer, Queues } from "../queues.js";
import type { FetchLike } from "../shopify.js";
import { adsenseConfig, googleConfig, metaConfig } from "./config.js";
import { adAccessToken } from "./credentials.js";

/** Replace what's stored for these days with what the platform reports now (campaigns can disappear). */
export async function storeAdDays(conn: AdConnection, since: string, until: string, rows: AdDayRow[]) {
  const inRange = rows.filter((r) => r.day >= since && r.day <= until);
  await systemDb.$transaction([
    systemDb.adCampaignDaily.deleteMany({ where: { connectionId: conn.id, day: { gte: since, lte: until } } }),
    systemDb.adCampaignDaily.createMany({
      data: inRange.map((r) => ({
        workspaceId: conn.workspaceId,
        storeId: conn.storeId,
        connectionId: conn.id,
        provider: conn.provider,
        accountId: conn.accountId,
        campaignId: r.campaignId,
        campaignName: r.campaignName.slice(0, 500),
        day: r.day,
        spend: r.spend,
        impressions: Math.min(r.impressions, 2_147_483_647),
        clicks: Math.min(r.clicks, 2_147_483_647),
        conversions: r.conversions,
        conversionValue: r.conversionValue,
        leads: r.leads,
        currency: conn.currency,
      })),
      skipDuplicates: true,
    }),
  ]);
  return inRange.length;
}

/**
 * Replace what's stored for these days with what AdSense reports now, and remember the account's
 * currency (AdSense only says it in reports).
 */
export async function storeAdsenseDays(conn: AdConnection, since: string, until: string, rows: AdsenseDayRow[], currency: string | null) {
  const inRange = rows.filter((r) => r.day >= since && r.day <= until);
  const cur = currency ?? conn.currency;
  await systemDb.$transaction([
    systemDb.adsenseDaily.deleteMany({ where: { connectionId: conn.id, day: { gte: since, lte: until } } }),
    systemDb.adsenseDaily.createMany({
      data: inRange.map((r) => ({
        workspaceId: conn.workspaceId,
        storeId: conn.storeId,
        connectionId: conn.id,
        accountId: conn.accountId,
        site: r.site.slice(0, 255),
        day: r.day,
        earnings: r.earnings,
        pageViews: Math.min(r.pageViews, 2_147_483_647),
        impressions: Math.min(r.impressions, 2_147_483_647),
        clicks: Math.min(r.clicks, 2_147_483_647),
        currency: cur,
      })),
      skipDuplicates: true,
    }),
    ...(currency && currency !== conn.currency ? [systemDb.adConnection.update({ where: { id: conn.id }, data: { currency } })] : []),
  ]);
  return inRange.length;
}

/** Fetch and store one ad account's days. Marks the connection with what happened. */
export async function syncAdConnection(connectionId: string, since: string, until: string, fetchImpl?: FetchLike) {
  const conn = await systemDb.adConnection.findUnique({ where: { id: connectionId } });
  if (!conn || !conn.enabled) return { skipped: true as const };
  try {
    const token = await adAccessToken(conn, fetchImpl);
    let stored: number;
    if (conn.provider === "meta") {
      const cfg = metaConfig(fetchImpl);
      if (!cfg) throw new AdsApiError("Meta isn't set up on this server", 503);
      let rows: AdDayRow[];
      try {
        rows = await metaCampaignDays(cfg, token, conn.accountId, since, until);
      } catch (err) {
        // A permission error means "connect again" only when ads_read itself was taken back.
        if (isMetaPermissionError(err)) {
          const granted = await metaGrantedPermissions(cfg, token).catch(() => null);
          if (granted && !granted.includes("ads_read")) throw new AdsAuthError("Meta's ads_read permission was taken back");
        }
        throw err;
      }
      stored = await storeAdDays(conn, since, until, rows);
    } else if (conn.provider === "google") {
      const cfg = googleConfig(fetchImpl);
      if (!cfg) throw new AdsApiError("Google Ads isn't set up on this server", 503);
      const rows: AdDayRow[] = await googleCampaignDays(cfg, token, conn, since, until);
      stored = await storeAdDays(conn, since, until, rows);
    } else if (conn.provider === "adsense") {
      const cfg = adsenseConfig(fetchImpl);
      if (!cfg) throw new AdsApiError("Google AdSense isn't set up on this server", 503);
      const report = await adsenseSiteDays(cfg, token, conn.accountId, since, until);
      stored = await storeAdsenseDays(conn, since, until, report.rows, report.currency);
    } else {
      throw new AdsApiError(`Unknown ad platform ${conn.provider}`, 400);
    }
    await systemDb.adConnection.update({ where: { id: conn.id }, data: { status: "active", lastError: null, lastSyncedAt: new Date() } });
    // Every day from `since` on is stored now: where the account's history starts, for the
    // dashboard's "No earlier data", keeping the earliest window any sync fetched in full.
    await systemDb.adConnection.updateMany({ where: { id: conn.id, OR: [{ historyFrom: null }, { historyFrom: { gt: since } }] }, data: { historyFrom: since } });
    return { skipped: false as const, stored };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    if (err instanceof AdsAuthError) {
      await systemDb.adConnection.update({ where: { id: conn.id }, data: { status: "reconnect", lastError: message } });
    } else if (err instanceof AdsApiError) {
      await systemDb.adConnection.update({ where: { id: conn.id }, data: { status: "error", lastError: message } });
    }
    throw err;
  }
}

/** A sync of one ad account's days. Rides the sync queue (no sync_jobs row: it isn't part of the store's import). */
export interface AdsSyncData {
  kind: "ads";
  connectionId: string;
  since: string;
  until: string;
}

/** The sync queue, typed for ad jobs. Its declared type stays SyncJobData so the many store-sync call sites don't change. */
export const adsQueue = (queues: Queues) => queues.sync as unknown as Producer<AdsSyncData>;

/** How far back a first connection fetches, and the daily re-check (platforms revise recent conversions). */
export const ADS_BACKFILL_DAYS = 90;
export const ADS_RECHECK_DAYS = 30;
export const ADS_RECENT_DAYS = 3;

/** The ad account's own today, which is what its "days" are. */
export function adToday(conn: Pick<AdConnection, "timezone">, now = new Date()): string {
  try {
    return localDay(now, conn.timezone || "UTC");
  } catch {
    return localDay(now, "UTC");
  }
}

/**
 * The days the daily re-check fetches: the last 30, or the first sync's whole 90 for an account
 * whose stored history falls short of them (its first sync failed and a later one worked, or it
 * was connected before history_from was recorded), so those days are filled in and its start
 * recorded. Not before any sync worked: the first sync, queued on connecting, is on its way.
 */
export function recheckDays(conn: Pick<AdConnection, "timezone" | "lastSyncedAt" | "historyFrom">, now = new Date()): number {
  const full = addDays(adToday(conn, now), -(ADS_BACKFILL_DAYS - 1));
  return conn.lastSyncedAt && (conn.historyFrom === null || conn.historyFrom > full) ? ADS_BACKFILL_DAYS : ADS_RECHECK_DAYS;
}

export async function enqueueAdSync(queues: Queues, conn: Pick<AdConnection, "id" | "timezone">, days: number, opts?: { delaySeconds?: number }) {
  const until = adToday(conn);
  await adsQueue(queues).send({ kind: "ads", connectionId: conn.id, since: addDays(until, -(days - 1)), until }, opts);
}

/**
 * Syncing a connection: what the platform reports per day into ad_campaign_daily / adsense_daily, and
 * the queue jobs that ask for it.
 *
 * What is stored is tracked as one unbroken run of days per connection: from history_from to
 * synced_through. A sync that would leave a hole after it (the account was waiting for a reconnect,
 * hidden, failing) fetches the hole first; history older than the first window is walked back 90 days
 * at a time, to 25 months; a hole the platform no longer reaches moves history_from past it, so the
 * dashboard says "No earlier data" rather than counting those days as nothing spent.
 */
import { Prisma, systemDb, type AdConnection } from "@app/db";
import { addDays, daysBetweenInclusive, localDay, type AdDayRow, type AdProvider, type AdsenseDayRow } from "@app/shared";
import {
  AdsApiError,
  AdsAuthError,
  AdsPermissionError,
  adsenseAccountHealth,
  adsenseSiteDays,
  classifyAdError,
  googleAccountHealth,
  googleCampaignDays,
  isMetaPermissionError,
  metaAccountHealth,
  metaCampaignDays,
  metaGrantedPermissions,
  type AdAccountHealth,
  type AdFailure,
  type MetaConfig,
} from "../ads.js";
import type { Coord } from "../coord.js";
import { logger } from "../logger.js";
import type { Producer, Queues } from "../queues.js";
import type { FetchLike } from "../shopify.js";
import { resolveAdAlerts } from "./alerts.js";
import { countGoogleAdsOperations, countingGoogleAdsFetch, googleAdsBudget, googleAdsBudgetAllows, googleAdsPaused, pauseGoogleAds } from "./budget.js";
import { AD_PROVIDER_NAME, adsenseConfig, googleClient, metaConfig } from "./config.js";
import { accessTokenAndPerson, adAccessToken, learnAdPerson } from "./credentials.js";
import { recordAdFailure } from "./status.js";

/** How far back a first connection fetches before its history is walked back. */
export const ADS_BACKFILL_DAYS = 90;
/** The daily re-check (platforms keep crediting conversions after the click): Meta's and AdSense's. */
export const ADS_RECHECK_DAYS = 30;
/** Google's: its conversion windows go up to 90 days, and a re-check costs the same operations whatever its length. */
export const ADS_GOOGLE_RECHECK_DAYS = 90;
/** The refresh of the last few days (today changes all day). */
export const ADS_RECENT_DAYS = 3;
/** The longest window one job fetches; longer ranges go on in follow-up jobs. */
export const ADS_WINDOW_DAYS = 90;
/** How far back history is walked: 25 months, so "same dates last year" works for any range up to a year. */
export const ADS_HISTORY_DAYS = 760;
/**
 * How far back each platform still reports: Meta keeps 37 months of insights (a little under, to stay
 * inside it), AdSense about three years, Google Ads longer than anything here asks for.
 */
export const ADS_MAX_LOOKBACK_DAYS: Record<AdProvider, number> = { meta: 1120, adsense: 1095, google: 3650 };
/** A requested sync ("Synchronizing") that hasn't finished in this long is taken as lost: another may be asked for. */
export const ADS_REQUEST_STALE_MS = 30 * 60_000;
/** History windows follow each other this far apart (plus a little jitter), so a backfill doesn't arrive in one burst. */
const ADS_HISTORY_SPACING_S = 120;
/** While a history window is on its way nobody else queues one; past this the chain is taken as broken. */
export const ADS_HISTORY_LEASE_MS = 30 * 60_000;

const maxLookback = (provider: string) => ADS_MAX_LOOKBACK_DAYS[provider as AdProvider] ?? ADS_MAX_LOOKBACK_DAYS.google;
const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);

/** The insert met the foreign key (the connection was deleted meanwhile), or an update found no row. */
const connectionGone = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2003" || err.code === "P2025");

const INT_MAX = 2_147_483_647;

/**
 * Replace what's stored for these days with what the platform reports now (campaigns can disappear).
 * Null when the connection was deleted meanwhile (a disconnect while this ran): nothing is written.
 */
export async function storeAdDays(conn: AdConnection, since: string, until: string, rows: AdDayRow[]): Promise<number | null> {
  const inRange = rows.filter((r) => r.day >= since && r.day <= until);
  try {
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
          impressions: Math.min(r.impressions, INT_MAX),
          clicks: Math.min(r.clicks, INT_MAX),
          linkClicks: r.linkClicks === null ? null : Math.min(r.linkClicks, INT_MAX),
          conversions: r.conversions,
          conversionValue: r.conversionValue,
          purchases: r.purchases,
          purchaseValue: r.purchaseValue,
          leads: r.leads,
          currency: conn.currency,
        })),
        skipDuplicates: true,
      }),
    ]);
  } catch (err) {
    if (connectionGone(err)) return null;
    throw err;
  }
  return inRange.length;
}

/**
 * Replace what's stored for these days with what AdSense reports now, and remember the account's
 * currency (AdSense only says it in reports). Null when the connection was deleted meanwhile.
 */
export async function storeAdsenseDays(conn: AdConnection, since: string, until: string, rows: AdsenseDayRow[], currency: string | null): Promise<number | null> {
  const inRange = rows.filter((r) => r.day >= since && r.day <= until);
  const cur = currency ?? conn.currency;
  try {
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
          pageViews: Math.min(r.pageViews, INT_MAX),
          impressions: Math.min(r.impressions, INT_MAX),
          clicks: Math.min(r.clicks, INT_MAX),
          currency: cur,
        })),
        skipDuplicates: true,
      }),
      ...(currency && currency !== conn.currency ? [systemDb.adConnection.update({ where: { id: conn.id }, data: { currency } })] : []),
    ]);
  } catch (err) {
    if (connectionGone(err)) return null;
    throw err;
  }
  return inRange.length;
}

/** The ad account's own today, which is what its "days" are. */
export function adToday(conn: Pick<AdConnection, "timezone">, now = new Date()): string {
  try {
    return localDay(now, conn.timezone || "UTC");
  } catch {
    return localDay(now, "UTC");
  }
}

/** The first day of the month before `day`'s. */
function previousMonthStart(day: string): string {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
}

/**
 * The days the daily re-check fetches again. Google: 90 (its conversion windows reach that far back,
 * and the conversions are credited to the day of the click). Meta: 30 (its attribution windows are 28
 * days at most). AdSense: 30, and in the first ten days of a month the whole month before, whose
 * estimated earnings AdSense finalizes then.
 */
export function recheckDays(conn: Pick<AdConnection, "timezone"> & { provider?: string }, now = new Date()): number {
  if (conn.provider === "google") return ADS_GOOGLE_RECHECK_DAYS;
  if (conn.provider === "adsense") {
    const today = adToday(conn, now);
    if (Number(today.slice(8, 10)) <= 10) return Math.max(ADS_RECHECK_DAYS, daysBetweenInclusive(previousMonthStart(today), today));
  }
  return ADS_RECHECK_DAYS;
}

/** Who asked for a sync. "request": a person (connect, reconnect, Refresh); "schedule": the cron; "history": the walk back. */
export type AdsSyncTrigger = "request" | "schedule" | "history";

type Coverage = Pick<AdConnection, "historyFrom" | "syncedThrough">;

/**
 * The window a sync fetches for [since, until], and what is left for a follow-up job. A hole between
 * the last day stored and `since` is fetched first; a window longer than ADS_WINDOW_DAYS is cut, the
 * oldest part first (history: the newest part first, next to what is stored). Days the platform no
 * longer reports are left out. Null: nothing left to fetch.
 */
export function planAdSyncWindow(
  conn: Pick<AdConnection, "provider" | "timezone"> & Coverage,
  since: string,
  until: string,
  trigger: AdsSyncTrigger,
  now = new Date(),
): { since: string; until: string; rest: { since: string; until: string } | null } | null {
  const oldest = addDays(adToday(conn, now), -(maxLookback(conn.provider) - 1));
  let s = later(since, oldest);
  const u = until;
  if (u < s) return null;
  if (trigger !== "history" && conn.historyFrom && conn.syncedThrough) {
    const next = addDays(conn.syncedThrough, 1);
    if (s > next) s = later(next, oldest);
  }
  if (daysBetweenInclusive(s, u) <= ADS_WINDOW_DAYS) return { since: s, until: u, rest: null };
  if (trigger === "history") return { since: addDays(u, -(ADS_WINDOW_DAYS - 1)), until: u, rest: { since: s, until: addDays(u, -ADS_WINDOW_DAYS) } };
  return { since: s, until: addDays(s, ADS_WINDOW_DAYS - 1), rest: { since: addDays(s, ADS_WINDOW_DAYS), until: u } };
}

/**
 * The unbroken run of stored days once [since, until] is stored too. A window that touches or overlaps
 * the run extends it; one that starts after a hole (days the platform no longer reports) starts a new
 * run, since nothing before the hole can be compared with; one wholly before the run, with a gap, is
 * kept but not counted until the gap is filled.
 */
export function mergeCoverage(cov: Coverage, since: string, until: string): { historyFrom: string; syncedThrough: string } | Coverage {
  const { historyFrom: h, syncedThrough: s } = cov;
  if (!h || !s) return { historyFrom: since, syncedThrough: until };
  if (since <= addDays(s, 1) && until >= addDays(h, -1)) return { historyFrom: earlier(h, since), syncedThrough: later(s, until) };
  if (since > addDays(s, 1)) return { historyFrom: since, syncedThrough: until };
  return cov;
}

/** Where the history walk stops: 25 months back, or as far as the platform still reports. */
export function historyTarget(conn: Pick<AdConnection, "provider" | "timezone">, now = new Date()): string {
  const today = adToday(conn, now);
  return later(addDays(today, -(ADS_HISTORY_DAYS - 1)), addDays(today, -(maxLookback(conn.provider) - 1)));
}

/** The next window of the walk back (the 90 days before history_from), or null once history reaches far enough. */
export function nextHistoryWindow(conn: Pick<AdConnection, "provider" | "timezone"> & Coverage, now = new Date()): { since: string; until: string } | null {
  if (!conn.historyFrom || !conn.syncedThrough) return null;
  const target = historyTarget(conn, now);
  if (conn.historyFrom <= target) return null;
  return { since: later(target, addDays(conn.historyFrom, -ADS_WINDOW_DAYS)), until: addDays(conn.historyFrom, -1) };
}

/** Extend the stored run with [since, until], over the values read (another sync may extend it meanwhile). */
async function extendCoverage(id: string, since: string, until: string): Promise<{ before: Coverage; after: Coverage } | null> {
  let row: Coverage | null = null;
  for (let i = 0; i < 5; i++) {
    row = await systemDb.adConnection.findUnique({ where: { id }, select: { historyFrom: true, syncedThrough: true } });
    if (!row) return null;
    const after = mergeCoverage(row, since, until);
    if (after.historyFrom === row.historyFrom && after.syncedThrough === row.syncedThrough) return { before: row, after: row };
    const { count } = await systemDb.adConnection.updateMany({ where: { id, historyFrom: row.historyFrom, syncedThrough: row.syncedThrough }, data: after });
    if (count) return { before: row, after };
  }
  logger.warn({ connectionId: id, since, until }, "ad history run not extended: kept changing under this sync");
  return row ? { before: row, after: row } : null;
}

/**
 * Meta answers a permission error both when ads_read itself was taken back (connecting again fixes it)
 * and when this login lost this one ad account (it doesn't): ask Meta which. An answer that can't be had
 * leaves it at the lost account.
 */
async function metaPermissionProblem(cfg: MetaConfig, token: string, err: unknown): Promise<unknown> {
  if (!(err instanceof AdsPermissionError) && !isMetaPermissionError(err)) return err;
  const granted = await metaGrantedPermissions(cfg, token).catch((e: unknown) => (e instanceof AdsAuthError ? ("ended" as const) : null));
  if (granted === "ended") return new AdsAuthError("Meta access has ended");
  if (granted && !granted.includes("ads_read")) return new AdsAuthError("Meta's ads_read permission was taken back", "scope_missing");
  return err instanceof AdsPermissionError ? err : new AdsPermissionError((err as AdsApiError).message, (err as AdsApiError).code);
}

const notSetUp = (provider: string) => new AdsApiError(`${AD_PROVIDER_NAME[provider as AdProvider] ?? provider} isn't set up on this server`, 503, undefined, "not_configured");

/** Fetch [since, until] and store it. Null when the connection was deleted meanwhile. */
async function fetchAndStore(conn: AdConnection, token: string, since: string, until: string, fetchImpl?: FetchLike): Promise<number | null> {
  if (conn.provider === "meta") {
    const cfg = metaConfig(fetchImpl);
    if (!cfg) throw notSetUp("meta");
    let rows: AdDayRow[];
    try {
      rows = await metaCampaignDays(cfg, token, conn.accountId, since, until);
    } catch (err) {
      throw await metaPermissionProblem(cfg, token, err);
    }
    return storeAdDays(conn, since, until, rows);
  }
  if (conn.provider === "google") {
    const cfg = googleClient(fetchImpl);
    if (!cfg) throw notSetUp("google");
    return storeAdDays(conn, since, until, await googleCampaignDays(cfg, token, conn, since, until));
  }
  if (conn.provider === "adsense") {
    const cfg = adsenseConfig(fetchImpl);
    if (!cfg) throw notSetUp("adsense");
    const report = await adsenseSiteDays(cfg, token, conn.accountId, since, until);
    return storeAdsenseDays(conn, since, until, report.rows, report.currency);
  }
  throw new AdsApiError(`Unknown ad platform ${conn.provider}`, 400);
}

/** The account's health at the platform now (its status, name, currency, time zone): one cheap call. */
async function readAccountHealth(conn: AdConnection, token: string, fetchImpl?: FetchLike): Promise<AdAccountHealth> {
  if (conn.provider === "meta") {
    const cfg = metaConfig(fetchImpl);
    if (!cfg) throw notSetUp("meta");
    try {
      return await metaAccountHealth(cfg, token, conn.accountId);
    } catch (err) {
      throw await metaPermissionProblem(cfg, token, err);
    }
  }
  if (conn.provider === "google") {
    const cfg = googleClient(fetchImpl);
    if (!cfg) throw notSetUp("google");
    return googleAccountHealth(cfg, token, conn);
  }
  const cfg = adsenseConfig(fetchImpl);
  if (!cfg) throw notSetUp("adsense");
  return adsenseAccountHealth(cfg, token, conn.accountId);
}

const validTimeZone = (tz: string | null): tz is string => {
  if (!tz) return false;
  try {
    localDay(new Date(), tz);
    return true;
  } catch {
    return false;
  }
};

/** Keep what the platform says about the account now: its status, and its name, currency and time zone when it says them. */
async function storeHealth(conn: AdConnection, h: AdAccountHealth) {
  await systemDb.adConnection.updateMany({
    where: { id: conn.id },
    data: {
      ...(h.status ? { accountStatus: h.status, accountStatusDetail: h.detail?.slice(0, 500) ?? null } : {}),
      ...(h.name ? { accountName: h.name.slice(0, 500) } : {}),
      ...(h.currency ? { currency: h.currency.slice(0, 10) } : {}),
      ...(validTimeZone(h.timezone) ? { timezone: h.timezone } : {}),
    },
  });
}

export interface AdSyncOptions {
  /** Who asked (AdsSyncData.trigger). Default "request". */
  trigger?: AdsSyncTrigger;
  /** Also read the account's health at the platform (the daily re-check). */
  health?: boolean;
  /** Only that: accounts with nothing new to read (closed, or this login lost them), asked once a day whether they're back. */
  healthOnly?: boolean;
  /** For the follow-ups: the rest of a long window, the next window of history, a catch-up once an account is back. */
  queues?: Queues;
  /** For Google's daily allowance (counting, holding background syncs back) and the history walk's lease. */
  coord?: Coord;
}

export type AdSyncResult =
  | { skipped: true; reason: "gone" | "hidden" | "no_token" | "nothing" | "budget" | "paused" | "health_failed" }
  | { skipped: false; stored: number; since: string; until: string; continued: boolean; health: AdAccountHealth | null };

/** Google's allowance ran out: nothing was read, and it's bizinsights' limit, not the account's. */
const QUOTA_FAILURE: AdFailure = { status: "error", code: "quota_exhausted", detail: null, retryable: false, retryAfterS: null };

/**
 * Fetch and store one ad account's days, and mark the connection with what happened. A lasting failure
 * (access ended or lost, the account gone, a refusal) is recorded at once and thrown; the queue retries
 * the others (outages, rate limits) and the last attempt's is recorded then (recordAdSyncFailure).
 * Whatever the platform's text, the connection keeps only the code and the cleaned detail.
 */
export async function syncAdConnection(connectionId: string, since: string, until: string, fetchImpl?: FetchLike, opts: AdSyncOptions = {}): Promise<AdSyncResult> {
  const conn = await systemDb.adConnection.findUnique({ where: { id: connectionId } });
  if (!conn) return { skipped: true, reason: "gone" };
  if (!conn.enabled) return { skipped: true, reason: "hidden" };
  // The person whose login it used has left (releaseUserAdGrants): no token until someone connects it again.
  if (!conn.accessTokenEnc) return { skipped: true, reason: "no_token" };
  const trigger = opts.trigger ?? "request";
  const google = conn.provider === "google";
  if (google && opts.coord) {
    if (await googleAdsPaused(opts.coord)) {
      // Someone asked: say why nothing changed. The schedule simply comes back later.
      if (trigger === "request") await recordAdFailure(conn.id, QUOTA_FAILURE, "sync");
      return { skipped: true, reason: "paused" };
    }
    if (trigger !== "request" && !googleAdsBudgetAllows(await googleAdsBudget(opts.coord), trigger)) return { skipped: true, reason: "budget" };
  }
  const counter = google ? countingGoogleAdsFetch(fetchImpl) : null;
  const f = counter?.fetchImpl ?? fetchImpl;
  try {
    return opts.healthOnly ? await healthCheck(conn, f, opts) : await syncWindow(conn, since, until, trigger, f, opts);
  } catch (err) {
    const failure = classifyAdError(err);
    if (google && failure.code === "quota_exhausted") {
      if (opts.coord) await pauseGoogleAds(opts.coord, failure.retryAfterS);
      if (trigger !== "history") await recordAdFailure(conn.id, failure, "sync");
      return { skipped: true, reason: "paused" };
    }
    // An older window that didn't come says nothing about the account now: only lasting news is kept from it.
    if (!failure.retryable && !(trigger === "history" && failure.status === "error")) await recordAdFailure(conn.id, failure, "sync");
    throw err;
  } finally {
    if (counter && opts.coord) await countGoogleAdsOperations(opts.coord, counter.operations());
  }
}

async function syncWindow(conn: AdConnection, since: string, until: string, trigger: AdsSyncTrigger, fetchImpl: FetchLike | undefined, opts: AdSyncOptions): Promise<AdSyncResult> {
  // A history window that is stored already (queued twice) has nothing to add.
  if (trigger === "history" && conn.historyFrom && since >= conn.historyFrom) return { skipped: true, reason: "nothing" };
  const w = planAdSyncWindow(conn, since, until, trigger);
  if (!w) return { skipped: true, reason: "nothing" };
  const { token, person } = await accessTokenAndPerson(conn, fetchImpl);
  const stored = await fetchAndStore(conn, token, w.since, w.until, fetchImpl);
  if (stored === null) return { skipped: true, reason: "gone" };

  // Afterwards and best effort: who granted access (so a disconnect knows whether the grant is shared;
  // a token refresh just now has looked already), asked when someone is waiting or with the daily
  // re-check, so a platform that won't say isn't asked every hour; and with the daily re-check the
  // account's health at the platform. Neither fails the sync.
  if (!conn.externalUserId && person === undefined && (trigger === "request" || opts.health || !conn.lastSyncedAt)) {
    await learnAdPerson(conn, token, fetchImpl).catch((err: unknown) => logger.info({ err, connectionId: conn.id }, "ad connection: who granted access not learned"));
  }
  let health: AdAccountHealth | null = null;
  if (opts.health) {
    health = await readAccountHealth(conn, token, fetchImpl).catch((err: unknown) => {
      logger.info({ err, connectionId: conn.id, errorCode: classifyAdError(err).code }, "ad account health not read");
      return null;
    });
    if (health) await storeHealth(conn, health);
  }

  const cov = await extendCoverage(conn.id, w.since, w.until);
  if (!cov) return { skipped: true, reason: "gone" };
  let continued = false;
  if (w.rest && opts.queues) {
    // Requested windows go on at once; the others a little apart.
    const delaySeconds = trigger === "request" ? 0 : trigger === "history" ? ADS_HISTORY_SPACING_S : 30 + Math.floor(Math.random() * 60);
    await adsQueue(opts.queues).send({ kind: "ads", connectionId: conn.id, since: w.rest.since, until: w.rest.until, trigger }, { delaySeconds });
    continued = true;
  }
  if (trigger !== "history") {
    const done = await systemDb.adConnection.updateMany({
      where: { id: conn.id },
      data: {
        status: "active",
        errorCode: null,
        lastError: null,
        consecutiveFailures: 0,
        lastSyncedAt: new Date(),
        // "Synchronizing" lasts until the last window someone asked for has landed.
        ...(continued && trigger === "request" ? {} : { syncRequestedAt: null }),
      },
    });
    if (!done.count) return { skipped: true, reason: "gone" };
    if (conn.status !== "active" || conn.consecutiveFailures > 0) {
      await resolveAdAlerts(conn, ["ads_reconnect", "ads_failing", "ads_unavailable"]).catch((err: unknown) => logger.warn({ err, connectionId: conn.id }, "ad alerts not resolved"));
    }
  }
  // The walk back: from the first window that landed, then from each history window that extended it.
  const lowered = cov.after.historyFrom !== null && (cov.before.historyFrom === null || cov.after.historyFrom < cov.before.historyFrom);
  if (opts.queues && lowered && (trigger === "history" || cov.before.historyFrom === null)) {
    await queueNextHistory({ ...conn, ...cov.after }, opts.queues, opts.coord).catch((err: unknown) => logger.warn({ err, connectionId: conn.id }, "next ad history window not queued"));
  }
  return { skipped: false, stored, since: w.since, until: w.until, continued, health };
}

/** The next history window, after the one that just landed. Google's waits while the day's allowance is busy (the schedule picks it up later). */
async function queueNextHistory(conn: AdConnection, queues: Queues, coord?: Coord) {
  if (conn.provider === "google" && coord && !googleAdsBudgetAllows(await googleAdsBudget(coord), "history")) return;
  await enqueueAdHistory(queues, coord, conn, { leaseMs: ADS_HISTORY_LEASE_MS, takeOver: true, delaySeconds: ADS_HISTORY_SPACING_S + Math.floor(Math.random() * 180) });
}

/**
 * The daily look at an account with nothing new to read: closed at the platform, or one this login
 * lost. When it's readable again it goes back to normal, and the days it missed are fetched.
 */
async function healthCheck(conn: AdConnection, fetchImpl: FetchLike | undefined, opts: AdSyncOptions): Promise<AdSyncResult> {
  let health: AdAccountHealth;
  try {
    health = await readAccountHealth(conn, await adAccessToken(conn, fetchImpl), fetchImpl);
  } catch (err) {
    const failure = classifyAdError(err);
    // Only access that ended is news here; anything else waits for tomorrow's look.
    if (failure.status === "reconnect") await recordAdFailure(conn.id, failure, "sync");
    logger.info({ connectionId: conn.id, errorCode: failure.code }, "ad account health check failed");
    return { skipped: true, reason: "health_failed" };
  }
  await storeHealth(conn, health);
  const today = adToday(conn);
  const back = conn.status === "permission" || (conn.status === "unavailable" && health.status === "active");
  if (back) {
    await systemDb.adConnection.updateMany({ where: { id: conn.id, status: conn.status }, data: { status: "active", errorCode: null, lastError: null, consecutiveFailures: 0 } });
    await resolveAdAlerts(conn, ["ads_reconnect", "ads_unavailable"]).catch((err: unknown) => logger.warn({ err, connectionId: conn.id }, "ad alerts not resolved"));
    if (opts.queues) await enqueueAdCatchUp(opts.queues, conn, { trigger: "schedule" });
    logger.info({ connectionId: conn.id, was: conn.status }, "ad account readable again");
  }
  return { skipped: false, stored: 0, since: today, until: today, continued: back, health };
}

/**
 * The queue gave up on an ad sync (its retries ran out): record what the last attempt met. Lasting
 * failures were recorded when they happened; an older history window says nothing about the account now.
 */
export async function recordAdSyncFailure(data: Pick<AdsSyncData, "connectionId" | "trigger">, err: unknown): Promise<void> {
  const failure = classifyAdError(err);
  if (!failure.retryable || data.trigger === "history") return;
  await recordAdFailure(data.connectionId, failure, "sync");
}

/**
 * A sync of one ad account's days. Rides the sync queue (no sync_jobs row: it isn't part of the store's
 * import). Every field after `until` is optional, so messages queued by an older version still work.
 */
export interface AdsSyncData {
  kind: "ads";
  connectionId: string;
  since: string;
  until: string;
  /** Absent: "request". */
  trigger?: AdsSyncTrigger;
  /** The daily re-check: also read the account's health. */
  health?: boolean;
  /** Only read the account's health (see AdSyncOptions). */
  healthOnly?: boolean;
}

/** The sync queue, typed for ad jobs. Its declared type stays SyncJobData so the many store-sync call sites don't change. */
export const adsQueue = (queues: Queues) => queues.sync as unknown as Producer<AdsSyncData>;

/**
 * Queue a sync of the last `days` days. `interactive`: someone is waiting for it, so the card says
 * "Synchronizing" until it lands (syncRequestedAt).
 */
export async function enqueueAdSync(
  queues: Queues,
  conn: Pick<AdConnection, "id" | "timezone">,
  days: number,
  opts: { delaySeconds?: number; trigger?: AdsSyncTrigger; health?: boolean; healthOnly?: boolean; interactive?: boolean } = {},
) {
  const until = adToday(conn);
  if (opts.interactive) await systemDb.adConnection.updateMany({ where: { id: conn.id }, data: { syncRequestedAt: new Date() } });
  await adsQueue(queues).send(
    {
      kind: "ads",
      connectionId: conn.id,
      since: addDays(until, -(Math.max(1, days) - 1)),
      until,
      trigger: opts.trigger ?? "request",
      ...(opts.health ? { health: true } : {}),
      ...(opts.healthOnly ? { healthOnly: true } : {}),
    },
    opts.delaySeconds !== undefined ? { delaySeconds: opts.delaySeconds } : undefined,
  );
}

/**
 * The window that brings a connection up to date: from a few days before the last day stored (the
 * platforms revise recent days) to today, or the first sync's 90 days when nothing is stored yet;
 * never further back than the platform reports.
 */
export function catchUpWindow(conn: Pick<AdConnection, "provider" | "timezone"> & Coverage, now = new Date()): { since: string; until: string } {
  const today = adToday(conn, now);
  const oldest = addDays(today, -(maxLookback(conn.provider) - 1));
  const from = conn.historyFrom && conn.syncedThrough ? addDays(conn.syncedThrough, -ADS_RECENT_DAYS) : addDays(today, -(ADS_BACKFILL_DAYS - 1));
  return { since: earlier(later(from, oldest), today), until: today };
}

/**
 * Bring a connection up to date: queue catchUpWindow (the sync cuts it into windows and fetches any
 * hole first). For connect, reconnect, showing an account again, Refresh, and an account that is back.
 *
 * `interactive` (someone pressed something): the card says "Synchronizing" until it lands, and asking
 * again while one is on its way queues nothing (returns null). Otherwise it's queued as scheduled work.
 */
export async function enqueueAdCatchUp(
  queues: Queues,
  conn: Pick<AdConnection, "id" | "provider" | "timezone" | "historyFrom" | "syncedThrough">,
  opts: { interactive?: boolean; trigger?: AdsSyncTrigger; delaySeconds?: number } = {},
): Promise<{ since: string; until: string } | null> {
  const w = catchUpWindow(conn);
  if (opts.interactive) {
    const stale = new Date(Date.now() - ADS_REQUEST_STALE_MS);
    const { count } = await systemDb.adConnection.updateMany({
      where: { id: conn.id, OR: [{ syncRequestedAt: null }, { syncRequestedAt: { lt: stale } }] },
      data: { syncRequestedAt: new Date() },
    });
    if (!count) return null;
  }
  try {
    await adsQueue(queues).send(
      { kind: "ads", connectionId: conn.id, since: w.since, until: w.until, trigger: opts.trigger ?? (opts.interactive ? "request" : "schedule") },
      opts.delaySeconds !== undefined ? { delaySeconds: opts.delaySeconds } : undefined,
    );
  } catch (err) {
    if (opts.interactive) await systemDb.adConnection.updateMany({ where: { id: conn.id }, data: { syncRequestedAt: null } }).catch(() => undefined);
    throw err;
  }
  return w;
}

const historyLease = (connectionId: string) => `ads-history:${connectionId}`;

/**
 * Queue the next window of history (nextHistoryWindow), unless one is on its way: the lease
 * `ads-history:<id>` is held for `leaseMs`. `takeOver`: the window before it just landed, so its lease
 * is passed on. Returns whether a window was queued.
 */
export async function enqueueAdHistory(
  queues: Queues,
  coord: Coord | undefined,
  conn: Pick<AdConnection, "id" | "provider" | "timezone"> & Coverage,
  opts: { leaseMs: number; takeOver?: boolean; delaySeconds?: number },
): Promise<boolean> {
  const next = nextHistoryWindow(conn);
  if (!next) return false;
  const key = historyLease(conn.id);
  if (coord) {
    if (opts.takeOver) await coord.release(key).catch(() => undefined);
    if (!(await coord.acquire(key, opts.leaseMs))) return false;
  }
  try {
    await adsQueue(queues).send({ kind: "ads", connectionId: conn.id, since: next.since, until: next.until, trigger: "history" }, { delaySeconds: opts.delaySeconds ?? 0 });
  } catch (err) {
    if (coord) await coord.release(key).catch(() => undefined);
    throw err;
  }
  return true;
}

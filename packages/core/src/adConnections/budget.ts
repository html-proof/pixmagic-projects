/**
 * bizinsights' own allowances at the ad platforms, shared by every merchant.
 *
 * Google Ads API operations: bizinsights' Cloud project may make a fixed number a day across every
 * merchant (Explorer access: 2,880 on real accounts), counted by Google over a sliding 24 hours
 * (https://developers.google.com/google-ads/api/docs/api-policy/access-levels). Each Search or
 * SearchStream request is one, and so is one Google refuses
 * (https://developers.google.com/google-ads/api/docs/best-practices/quotas).
 *
 * The syncs count what they spend here, in the coordinator, so the background ones can stop short of
 * the allowance and leave the rest to people connecting accounts and opening reports. When Google
 * says the allowance is used up anyway, Google Ads syncs pause for a while.
 *
 * Meta's application request limit: bizinsights' app may make so many Graph API calls over a rolling
 * hour, counted by Meta across every merchant's account
 * (https://developers.facebook.com/docs/graph-api/overview/rate-limiting/). Over it, Meta answers
 * error code 4 to every call, whichever account it is for, until enough of the hour's calls have aged
 * out. So the first Meta Ads call told so pauses Meta Ads syncs and live reports for a while, rather
 * than every account's job calling Meta to be told the same and waiting on its own. Meta's other
 * throttles (17, 32, 613, the business use case codes 80000-80099) are one account's or one person's,
 * and stay with that account's job.
 */
import { AdsRateLimitedError } from "../ads.js";
import type { Coord } from "../coord.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";

/** Explorer access, on real accounts. GOOGLE_ADS_DAILY_OPERATIONS overrides it once a higher access level is granted. */
export const GOOGLE_ADS_DAILY_OPERATIONS = 2880;
/** Scheduled syncs stop at this share of the allowance; connects, Refresh and reports may use the rest. */
export const GOOGLE_ADS_SCHEDULED_SHARE = 0.8;
/** Fetching older history waits for a quieter day: it stops at this share. */
export const GOOGLE_ADS_HISTORY_SHARE = 0.6;
/** How long Google Ads syncs pause when Google says the allowance is used up and doesn't say for how long. */
export const GOOGLE_ADS_PAUSE_S = 3600;

/** The allowance: the GOOGLE_ADS_DAILY_OPERATIONS setting when it is set, else Explorer's. */
export function googleAdsDailyOperations(): number {
  return env().GOOGLE_ADS_DAILY_OPERATIONS ?? GOOGLE_ADS_DAILY_OPERATIONS;
}

const HOUR_MS = 3_600_000;
const hourOf = (ms: number) => Math.floor(ms / HOUR_MS);
// One counter per clock hour (its window is that hour), plus what it last reached, which can be read
// back: the coordinator's counters only answer when they count.
const countKey = (hour: number) => `google-ads-ops:${hour}`;
const seenKey = (hour: number) => `google-ads-ops-seen:${hour}`;
const PAUSE_KEY = "google-ads-paused";

/** Record `n` operations made just now. Never throws: counting must not fail a sync that worked. */
export async function countGoogleAdsOperations(coord: Coord, n: number, now = Date.now()): Promise<void> {
  if (n <= 0) return;
  const hour = hourOf(now);
  try {
    let total = 0;
    for (let i = 0; i < n; i++) total = await coord.hit(countKey(hour), 3600);
    // The coordinator picks a counter's window by its own clock: a call that reaches it just after the
    // hour has ended starts a new counter from 1. So the figure kept for the hour only ever grows; two
    // syncs finishing together, or one across the hour, leave it a few short at most.
    const before = Number(await coord.peek(seenKey(hour))) || 0;
    if (total > before) await coord.put(seenKey(hour), String(total), 25 * 3600);
  } catch (err) {
    logger.warn({ err, n }, "google ads operations not counted");
  }
}

/** Operations counted over the last 24 hours (the current hour and the 23 before it). */
export async function googleAdsOperationsToday(coord: Coord, now = Date.now()): Promise<number> {
  const hour = hourOf(now);
  const seen = await Promise.all(Array.from({ length: 24 }, (_, i) => coord.peek(seenKey(hour - i)).catch(() => null)));
  return seen.reduce((sum, v) => sum + (Number(v) || 0), 0);
}

/** Google said the allowance is used up: hold Google Ads syncs back for `seconds` (Google's own wait when it gave one). */
export async function pauseGoogleAds(coord: Coord, seconds: number | null): Promise<void> {
  const s = Math.min(24 * 3600, Math.max(900, Math.round(seconds ?? GOOGLE_ADS_PAUSE_S)));
  await coord.put(PAUSE_KEY, new Date(Date.now() + s * 1000).toISOString(), s);
  logger.warn({ pauseSeconds: s }, "google ads: daily operations used up; syncs paused");
}

export async function googleAdsPaused(coord: Coord): Promise<boolean> {
  return (await coord.peek(PAUSE_KEY).catch(() => null)) !== null;
}

export interface GoogleAdsBudget {
  paused: boolean;
  /** Operations counted over the last 24 hours. */
  used: number;
  /** The daily allowance. */
  limit: number;
}

export async function googleAdsBudget(coord: Coord): Promise<GoogleAdsBudget> {
  const [paused, used] = await Promise.all([googleAdsPaused(coord), googleAdsOperationsToday(coord)]);
  return { paused, used, limit: googleAdsDailyOperations() };
}

/** Whether a background Google Ads sync may run now: scheduled ones up to 80% of the allowance, history up to 60%. */
export function googleAdsBudgetAllows(b: GoogleAdsBudget, trigger: "schedule" | "history"): boolean {
  if (b.paused) return false;
  return b.used < b.limit * (trigger === "history" ? GOOGLE_ADS_HISTORY_SHARE : GOOGLE_ADS_SCHEDULED_SHARE);
}

/**
 * How long Meta Ads pauses when Meta says bizinsights' app is over its limit. Meta gives no wait for this
 * limit (calls fail until the hour's count falls back under it). A quarter of the rolling hour lets the
 * oldest calls age out without holding every account back for the whole hour; if Meta still says no,
 * the first call after the pause starts another.
 */
export const META_ADS_PAUSE_S = 900;
/** Meta counts the app's calls over a rolling hour: after an hour without any, none are left in the count. */
const META_ADS_PAUSE_MAX_S = 3600;
const META_PAUSE_KEY = "meta-ads-paused";

/** Meta's application request limit (Graph error code 4): bizinsights' app, not the account, is over its calls for the hour. */
export const isMetaAppLimit = (err: unknown): err is AdsRateLimitedError => err instanceof AdsRateLimitedError && err.code === 4;

/**
 * Meta said bizinsights' app is over its limit: hold Meta Ads syncs and live reports back for
 * META_ADS_PAUSE_S, or for `seconds` when that is longer, at most an hour. `seconds` is the wait in the
 * failed call's usage headers, which are its account's (metaRetryAfterS), not the app's: a longer one is
 * kept, a shorter one says nothing about the app. A pause is never shortened: another call told the same
 * a moment later, its own account naming a shorter wait, leaves the longer pause standing. Returns how
 * long the pause still runs, or null when the coordinator couldn't keep it. Never throws: the call's own
 * failure is handled the same either way.
 */
export async function pauseMetaAds(coord: Coord, seconds: number | null): Promise<number | null> {
  const s = Math.min(META_ADS_PAUSE_MAX_S, Math.max(META_ADS_PAUSE_S, Math.round(seconds ?? 0)));
  const until = Date.now() + s * 1000;
  try {
    const current = await metaAdsPausedUntil(coord);
    if (current && current.getTime() >= until) return Math.ceil((current.getTime() - Date.now()) / 1000);
    await coord.put(META_PAUSE_KEY, new Date(until).toISOString(), s);
  } catch (err) {
    logger.warn({ err }, "meta ads: pause not kept");
    return null;
  }
  logger.warn({ pauseSeconds: s }, "meta ads: application request limit reached; meta ads syncs and reports paused");
  return s;
}

/** Until when Meta Ads calls are held back (pauseMetaAds); null when they aren't. */
export async function metaAdsPausedUntil(coord: Coord): Promise<Date | null> {
  const v = await coord.peek(META_PAUSE_KEY).catch(() => null);
  const until = v ? new Date(v) : null;
  return until && until.getTime() > Date.now() ? until : null;
}

export async function metaAdsPaused(coord: Coord): Promise<boolean> {
  return (await metaAdsPausedUntil(coord)) !== null;
}

/** A fetch that counts the requests that reach the Google Ads API (each is an operation, refused or not). */
export function countingGoogleAdsFetch(f: FetchLike = fetch): { fetchImpl: FetchLike; operations: () => number } {
  let n = 0;
  const fetchImpl = ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://googleads.googleapis.com/")) n++;
    return f(input, init);
  }) as FetchLike;
  return { fetchImpl, operations: () => n };
}

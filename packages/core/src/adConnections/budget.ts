/**
 * Google Ads API operations: bizinsights' Cloud project may make a fixed number a day across every
 * merchant (Explorer access: 2,880 on real accounts), counted by Google over a sliding 24 hours
 * (https://developers.google.com/google-ads/api/docs/api-policy/access-levels). Each Search or
 * SearchStream request is one, and so is one Google refuses
 * (https://developers.google.com/google-ads/api/docs/best-practices/quotas).
 *
 * The syncs count what they spend here, in the coordinator, so the background ones can stop short of
 * the allowance and leave the rest to people connecting accounts and opening reports. When Google
 * says the allowance is used up anyway, Google Ads syncs pause for a while.
 */
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

/** The allowance: GOOGLE_ADS_DAILY_OPERATIONS when the config carries it, else Explorer's. */
export function googleAdsDailyOperations(): number {
  // Read through env() like every setting; the constant stands in until the config schema lists it.
  const v = Number((env() as unknown as Record<string, unknown>).GOOGLE_ADS_DAILY_OPERATIONS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : GOOGLE_ADS_DAILY_OPERATIONS;
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
    // Two syncs finishing together may each write their own total: the hour's figure is off by a few at most.
    await coord.put(seenKey(hour), String(total), 25 * 3600);
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

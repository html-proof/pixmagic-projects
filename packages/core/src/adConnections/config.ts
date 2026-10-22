/** Which ad platforms are set up: each one's keys from the config, its name, and its OAuth callback. */
import type { AdProvider } from "@app/shared";
import type { AdsenseConfig, GoogleConfig, MetaConfig, SupermetricsConfig } from "../ads.js";
import { env, switchedOn } from "../env.js";
import type { FetchLike } from "../shopify.js";

/** The platform's keys, or null while they aren't set (the Connect button says so). */
export function metaConfig(fetchImpl?: FetchLike): MetaConfig | null {
  const e = env();
  if (!e.META_APP_ID || !e.META_APP_SECRET) return null;
  return { appId: e.META_APP_ID, appSecret: e.META_APP_SECRET, version: e.META_API_VERSION, configId: e.META_CONFIG_ID || undefined, fetchImpl };
}

/**
 * Google Ads for new connections: the same Google OAuth client as AdSense, offered once its Cloud
 * project may reach real accounts (GOOGLE_ADS_ENABLED). Only the Connect button and the listing of
 * what's configured go by this; accounts already connected keep working through googleClient().
 */
export function googleConfig(fetchImpl?: FetchLike): GoogleConfig | null {
  if (!switchedOn(env().GOOGLE_ADS_ENABLED)) return null;
  return googleClient(fetchImpl);
}

/**
 * Google Ads for accounts already connected: token refresh, syncs, reports and the sign-in's callback.
 * Switching GOOGLE_ADS_ENABLED off stops new connections only; their data keeps coming.
 */
export function googleClient(fetchImpl?: FetchLike): GoogleConfig | null {
  const e = env();
  if (!e.GOOGLE_ADS_CLIENT_ID || !e.GOOGLE_ADS_CLIENT_SECRET) return null;
  return { clientId: e.GOOGLE_ADS_CLIENT_ID, clientSecret: e.GOOGLE_ADS_CLIENT_SECRET, version: e.GOOGLE_ADS_API_VERSION, fetchImpl };
}

/** AdSense signs in through the same Google OAuth client as Google Ads, and needs nothing else. */
export function adsenseConfig(fetchImpl?: FetchLike): AdsenseConfig | null {
  const e = env();
  if (!e.GOOGLE_ADS_CLIENT_ID || !e.GOOGLE_ADS_CLIENT_SECRET) return null;
  return { clientId: e.GOOGLE_ADS_CLIENT_ID, clientSecret: e.GOOGLE_ADS_CLIENT_SECRET, fetchImpl };
}

export const adsConfigured = (): Record<AdProvider, boolean> => ({ meta: metaConfig() !== null, google: googleConfig() !== null, adsense: adsenseConfig() !== null });

/**
 * Platforms whose sign-in isn't open to everyone yet. Meta: until ads_read has Advanced Access
 * (META_ADS_ADVANCED_ACCESS), Facebook lets in only the people added to bizinsights' own app and
 * turns everyone else away on its own page. Google Ads: until Google verifies bizinsights' use of
 * the sensitive adwords scope (GOOGLE_ADS_OAUTH_VERIFIED), Google shows a "Google hasn't verified
 * this app" screen first (people can continue past it) and lets at most 100 new people in. AdSense
 * asks only for a non-sensitive scope, so it is never restricted.
 */
export const adsRestricted = (): Record<AdProvider, boolean> => ({
  meta: metaConfig() !== null && !switchedOn(env().META_ADS_ADVANCED_ACCESS),
  google: googleConfig() !== null && !switchedOn(env().GOOGLE_ADS_OAUTH_VERIFIED),
  adsense: false,
});

/** bizinsights' Supermetrics team (docs/supermetrics.md), or null while its API key isn't set: nothing about Supermetrics is offered then. */
export function supermetricsConfig(fetchImpl?: FetchLike): SupermetricsConfig | null {
  const e = env();
  if (!e.SUPERMETRICS_API_KEY) return null;
  return { apiKey: e.SUPERMETRICS_API_KEY, baseUrl: e.SUPERMETRICS_API_URL, fetchImpl };
}

/** The platforms offered through Supermetrics: those SUPERMETRICS_SOURCES lists, once the key is set. */
export function supermetricsProviders(): Record<AdProvider, boolean> {
  const on = supermetricsConfig() !== null;
  const listed = new Set(
    env()
      .SUPERMETRICS_SOURCES.split(",")
      .map((s) => s.trim().toLowerCase()),
  );
  return { meta: on && listed.has("meta"), google: on && listed.has("google"), adsense: on && listed.has("adsense") };
}

/** The platform's name in messages. */
export const AD_PROVIDER_NAME: Record<AdProvider, string> = { meta: "Meta", google: "Google Ads", adsense: "Google AdSense" };

/** Where the platform sends people back. Must be registered exactly like this in the Meta app and the Google OAuth client. */
export const adsRedirectUri = (provider: AdProvider) => `${env().APP_URL}/api/ads/${provider}/callback`;

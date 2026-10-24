/**
 * Which ad platforms are set up: each one's keys from the config, Nango (which every platform is
 * connected through, docs/nango.md), its name, and the OAuth callback the platforms send people back to.
 */
import type { AdProvider } from "@app/shared";
import type { AdsenseConfig, GoogleConfig, MetaConfig, NangoConfig } from "../ads.js";
import { env, switchedOn } from "../env.js";
import type { FetchLike } from "../shopify.js";

/**
 * The platform's keys, or null while they aren't set (the Connect button says so). Meta's secret signs
 * every call (appsecret_proof) and Meta's deauthorize and data-deletion callbacks.
 */
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
 * Google Ads for accounts already connected: syncs, reports, checking whose a token is, and renewing a
 * connection made before Nango until it is moved there (migrate.ts). Switching GOOGLE_ADS_ENABLED off
 * stops new connections only; their data keeps coming.
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

/**
 * Platforms this server holds the keys for (its own app's), before asking whether Nango can connect
 * them (connectableAdProviders in nango.ts: the platform's integration has to exist there too).
 */
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

/** bizinsights' Nango environment (docs/nango.md), or null while its secret key isn't set: no platform can be connected then. */
export function nangoConfig(fetchImpl?: FetchLike): NangoConfig | null {
  const e = env();
  if (!e.NANGO_SECRET_KEY) return null;
  return { secretKey: e.NANGO_SECRET_KEY, apiUrl: e.NANGO_API_URL, fetchImpl };
}

/**
 * The platforms this server connects through Nango: those NANGO_PROVIDERS lists (all three by default),
 * once the key is set and the platform's own app is set up on this server (its tokens are read and
 * checked with it). Google Ads only when new Google Ads connections are open at all (GOOGLE_ADS_ENABLED).
 * Whether Nango holds each one's integration is asked of Nango (connectableAdProviders, nango.ts).
 */
export function nangoProviders(): Record<AdProvider, boolean> {
  const on = nangoConfig() !== null;
  const listed = new Set(
    env()
      .NANGO_PROVIDERS.split(",")
      .map((s) => s.trim().toLowerCase()),
  );
  return {
    meta: on && listed.has("meta") && metaConfig() !== null,
    google: on && listed.has("google") && googleConfig() !== null,
    adsense: on && listed.has("adsense") && adsenseConfig() !== null,
  };
}

/**
 * Where Nango sends the browser back from the platform's consent screen: bizinsights' own address,
 * which forwards to Nango's callback (routes/adsNango.ts). Registered with Meta and Google, and set as
 * the Nango environment's callback URL, so the consent screens name bizinsights.io, a domain Google
 * has verified, never nango.dev.
 */
export const nangoCallbackUri = () => `${env().APP_URL}/api/ads/nango/oauth-callback`;

/** The platform's name in messages. */
export const AD_PROVIDER_NAME: Record<AdProvider, string> = { meta: "Meta", google: "Google Ads", adsense: "Google AdSense" };

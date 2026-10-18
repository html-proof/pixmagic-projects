/** Which ad platforms are set up: each one's keys from the config, its name, and its OAuth callback. */
import type { AdProvider } from "@app/shared";
import type { AdsenseConfig, GoogleConfig, MetaConfig } from "../ads.js";
import { env, switchedOn } from "../env.js";
import type { FetchLike } from "../shopify.js";

/** The platform's keys, or null while they aren't set (the Connect button says so). */
export function metaConfig(fetchImpl?: FetchLike): MetaConfig | null {
  const e = env();
  if (!e.META_APP_ID || !e.META_APP_SECRET) return null;
  return { appId: e.META_APP_ID, appSecret: e.META_APP_SECRET, version: e.META_API_VERSION, configId: e.META_CONFIG_ID || undefined, fetchImpl };
}

/** Google Ads: the same Google OAuth client as AdSense, switched on once its Cloud project may reach real accounts. */
export function googleConfig(fetchImpl?: FetchLike): GoogleConfig | null {
  const e = env();
  if (!e.GOOGLE_ADS_CLIENT_ID || !e.GOOGLE_ADS_CLIENT_SECRET || !switchedOn(e.GOOGLE_ADS_ENABLED)) return null;
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
 * Platforms whose sign-in only lets in the people added to bizinsights' own app: Meta, until ads_read
 * has Advanced Access (META_ADS_ADVANCED_ACCESS). Facebook turns everyone else away on its own page.
 */
export const adsRestricted = (): Record<AdProvider, boolean> => ({
  meta: metaConfig() !== null && !switchedOn(env().META_ADS_ADVANCED_ACCESS),
  google: false,
  adsense: false,
});

/** The platform's name in messages. */
export const AD_PROVIDER_NAME: Record<AdProvider, string> = { meta: "Meta", google: "Google Ads", adsense: "Google AdSense" };

/** Where the platform sends people back. Must be registered exactly like this in the Meta app and the Google OAuth client. */
export const adsRedirectUri = (provider: AdProvider) => `${env().APP_URL}/api/ads/${provider}/callback`;

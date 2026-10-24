/**
 * Meta Marketing API, Google Ads API and AdSense Management API clients, and Nango's API, which every
 * platform is authorized through ("Continue with Meta Ads" / "Google Ads" / "Google AdSense"): the
 * accounts a person can see, and daily numbers per campaign (ads) or per site (AdSense). One module
 * per platform in ads/; this file is the one place the rest of core imports them from.
 *
 * Read-only by design: the only permissions asked for are `ads_read` (Meta), the Google Ads scope
 * used for reporting and `adsense.readonly`. Nothing here creates, edits or pauses an ad.
 *
 * Every function takes its keys and a fetch implementation as arguments, so tests run against
 * fakes and nothing in here reads the environment.
 */
export * from "./ads/common.js";
export * from "./ads/meta.js";
export * from "./ads/googleOAuth.js";
export * from "./ads/googleAds.js";
export * from "./ads/googleAdsSource.js";
export * from "./ads/adsense.js";
export * from "./ads/nango.js";

import type { ReactNode } from "react";
import { GoogleIcon, MetaIcon } from "@/components/BrandIcons";
import type { AdProvider } from "@/lib/adConnections";

/**
 * What differs between the Google Ads, Meta Ads and Google AdSense cards on Settings → Connect your
 * business and Settings → Advertising; the rest is the same card (AdPlatformCard).
 */
export interface AdPlatformInfo {
  name: string;
  /** What it brings, under the name. */
  sub: string;
  /** The button that opens the platform's sign-in, before anything is connected. */
  button: string;
  /** The same button while the browser leaves. */
  opening: string;
  Icon: (p: { size?: number }) => ReactNode;
  /** What connecting turns on (Connect your business). */
  features: string[];
  /** What happens on the platform's screen, before anyone is sent there. */
  how: string;
  /** Where a login without an account can create one, or be given access to one. */
  home: Array<{ url: string; label: string }>;
  /** The retry button after a sign-in that reached no account. */
  retry: string;
}

export const AD_PLATFORMS: Record<AdProvider, AdPlatformInfo> = {
  google: {
    name: "Google Ads",
    sub: "Search, Shopping, YouTube and Performance Max: spend, clicks, conversions and the campaigns behind them",
    button: "Connect Google Ads",
    opening: "Opening Google…",
    Icon: GoogleIcon,
    features: ["Ad spend next to your sales", "Campaigns, ad groups, devices and countries", "Clicks, conversions and ROAS"],
    how: "Google asks you to choose your Google account and allow access. If it can reach several ad accounts (an agency or manager account), you pick the ones for this store. bizinsights only reads reports: it can't create, change or pause ads, or spend money.",
    home: [{ url: "https://ads.google.com/", label: "Open ads.google.com" }],
    retry: "Choose another Google account",
  },
  meta: {
    name: "Meta Ads",
    sub: "Facebook and Instagram ads: spend, reach, clicks and the purchases Meta reports",
    button: "Continue with Meta Ads",
    opening: "Opening Meta…",
    Icon: MetaIcon,
    features: ["Ad spend next to your sales", "Campaigns, ad sets, ads, placements and devices", "Reach, clicks, purchases and ROAS"],
    how: "Meta asks you to log in and choose the ad accounts to share. Access is read-only: bizinsights can't create, change or pause ads, or spend money.",
    home: [
      { url: "https://adsmanager.facebook.com/", label: "Open Ads Manager" },
      { url: "https://business.facebook.com/settings/ad-accounts", label: "Open Business settings" },
    ],
    retry: "Connect again",
  },
  adsense: {
    name: "Google AdSense",
    sub: "What your site earns from ads shown on it: earnings, page views, impressions and clicks",
    button: "Connect Google AdSense",
    opening: "Opening Google…",
    Icon: GoogleIcon,
    features: ["Ad earnings next to your sales", "Earnings by site, country and device", "Page views, impressions and clicks"],
    how: "Google asks you to choose the Google account that owns your AdSense and allow read-only access to its reports. bizinsights can't change your sites, ads or payments.",
    home: [{ url: "https://adsense.google.com/", label: "Open AdSense" }],
    retry: "Choose another Google account",
  },
};

/** The order the cards appear in, on both pages. */
export const AD_PLATFORM_ORDER: AdProvider[] = ["google", "meta", "adsense"];

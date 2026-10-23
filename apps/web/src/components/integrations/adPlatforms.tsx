import type { ReactNode } from "react";
import {
  Briefcase,
  ChartColumn,
  ChartNoAxesCombined,
  CircleDollarSign,
  Globe,
  Image as ImageIcon,
  Layers,
  Megaphone,
  MonitorSmartphone,
  ShieldCheck,
  Target,
  TrendingUp,
  UserRoundCheck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { AdsenseIcon, GoogleAdsIcon, MetaIcon } from "@/components/BrandIcons";
import type { AdProvider } from "@/lib/adConnections";

/** The colours of the "what bizinsights reads" chips on Settings → Advertising (CSS variables of globals.css). */
export type ChipTone = "info" | "violet" | "good" | "orange" | "rose";

/**
 * What differs between the Google Ads, Meta Ads and Google AdSense cards on Settings → Advertising
 * (AdPlatformPanel), and their names and icons on Settings → Connect your business (ConnectChoices).
 */
export interface AdPlatformInfo {
  name: string;
  /** What it brings, under the name. */
  sub: string;
  /** The button that opens the platform's sign-in, before anything is connected (both pages: the review packs quote it). */
  button: string;
  /** The same button while the browser leaves. */
  opening: string;
  Icon: (p: { size?: number }) => ReactNode;
  /** What connecting turns on (Connect your business; "What you'll get" on Settings → Advertising). */
  features: string[];
  /** What bizinsights reads from it, in the order the platform nests it (Settings → Advertising). */
  reads: Array<{ label: string; icon: LucideIcon; tone: ChipTone }>;
  /** What someone needs before pressing the button (Settings → Advertising). */
  needs: Array<{ label: string; icon: LucideIcon }>;
  /** Beside "What you'll get" while nothing is connected (Settings → Advertising). */
  promo: { title: string; text: string; button: string; icon: LucideIcon };
  /** Its page in the Advertising area. */
  page: string;
  /** What happens on the platform's screen, before anyone is sent there. */
  how: string;
  /** Where a login without an account can create one, or be given access to one. */
  home: Array<{ url: string; label: string }>;
  /** The retry button after a sign-in that reached no account. */
  retry: string;
}

/** Every platform's last requirement: connecting is for those who may manage integrations (Team & Access). */
const MANAGE = { label: "The Manage integrations permission here", icon: ShieldCheck };

export const AD_PLATFORMS: Record<AdProvider, AdPlatformInfo> = {
  google: {
    name: "Google Ads",
    sub: "Search, Shopping, YouTube and Performance Max: spend, clicks, conversions and the campaigns behind them",
    button: "Continue with Google Ads",
    opening: "Opening Google…",
    Icon: GoogleAdsIcon,
    features: ["Campaign performance and spend", "Ad groups, devices and countries", "Clicks, conversions and their value", "Ad spend next to your sales, with ROAS"],
    reads: [
      { label: "Campaigns", icon: Megaphone, tone: "info" },
      { label: "Ad groups", icon: Layers, tone: "violet" },
      { label: "Devices & countries", icon: Globe, tone: "good" },
      { label: "Conversions", icon: Target, tone: "orange" },
      { label: "Cost & spend", icon: CircleDollarSign, tone: "rose" },
    ],
    needs: [
      { label: "A Google Ads account", icon: Briefcase },
      { label: "A Google login that can open it, directly or through a manager account", icon: UserRoundCheck },
      MANAGE,
    ],
    promo: {
      title: "Put your Google Ads next to your sales",
      text: "See what Search, Shopping, YouTube and Performance Max spend and bring, beside your Shopify orders.",
      button: "Connect Google Ads",
      icon: TrendingUp,
    },
    page: "/advertising/google",
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
    features: ["Campaign performance and spend", "Ad set and ad level figures", "Placements, devices, countries, age and gender", "Reach, purchases and ROAS next to your sales"],
    reads: [
      { label: "Campaigns", icon: Megaphone, tone: "info" },
      { label: "Ad sets", icon: Layers, tone: "violet" },
      { label: "Ads", icon: ImageIcon, tone: "good" },
      { label: "Audience", icon: Users, tone: "orange" },
      { label: "Spend & ROAS", icon: CircleDollarSign, tone: "rose" },
    ],
    needs: [
      { label: "A Meta ad account, in Ads Manager or a Business portfolio", icon: Briefcase },
      { label: "A Facebook login that can see the account's performance", icon: UserRoundCheck },
      MANAGE,
    ],
    promo: {
      title: "Boost your marketing with Meta Ads",
      text: "See what your Facebook and Instagram ads spend and bring, next to your sales.",
      button: "Connect Meta Ads",
      icon: Megaphone,
    },
    page: "/advertising/meta",
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
    button: "Continue with Google AdSense",
    opening: "Opening Google…",
    Icon: AdsenseIcon,
    features: ["Estimated earnings, day by day", "Page views, impressions and clicks", "Earnings by site, country and device", "Ad earnings next to your sales"],
    reads: [
      { label: "Earnings", icon: Wallet, tone: "info" },
      { label: "Performance", icon: ChartColumn, tone: "violet" },
      { label: "Sites", icon: Globe, tone: "good" },
      { label: "Countries & devices", icon: MonitorSmartphone, tone: "orange" },
    ],
    needs: [
      { label: "A Google AdSense account", icon: Briefcase },
      { label: "The Google account you sign in to AdSense with", icon: UserRoundCheck },
      MANAGE,
    ],
    promo: {
      title: "Track your AdSense earnings",
      text: "See what your site earns from ads, day by day, next to your sales.",
      button: "Connect AdSense",
      icon: ChartNoAxesCombined,
    },
    page: "/advertising/adsense",
    how: "Google asks you to choose the Google account that owns your AdSense and allow read-only access to its reports. bizinsights can't change your sites, ads or payments.",
    home: [{ url: "https://adsense.google.com/", label: "Open AdSense" }],
    retry: "Choose another Google account",
  },
};

/** The order the cards appear in, on both pages. */
export const AD_PLATFORM_ORDER: AdProvider[] = ["google", "meta", "adsense"];

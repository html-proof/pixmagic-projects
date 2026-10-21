/**
 * The Google Ads analytics page's API (apps/api/src/routes/adsGoogleDemo.ts): the status of both
 * modes (the demo and the real sign-in), and the analytics for one of the store's Google Ads
 * connections, the demo by default. The figures' shapes are the shared ones the API computes with.
 */
import type { AdsMetrics, AdsPeriod, AdsRecommendation, CampaignAnalytics, CampaignPage, ConversionDay } from "@app/shared/adsAnalytics";
import type { DemoBreakdownRow, DemoStoreDay, DemoStoreTotals, GoogleAdsConnectionStatus } from "@app/shared/adsDemo";
import type { AdConnection } from "@/lib/adConnections";

export interface GoogleAdsStatus {
  provider: "google_ads";
  demo: {
    enabled: boolean;
    status: GoogleAdsConnectionStatus;
    connection: AdConnection | null;
    account: DemoAccount | null;
    badge: string;
    disclaimer: string;
  };
  production: {
    configured: boolean;
    restricted: boolean;
    /** The settings the real sign-in still lacks on this server, by name. */
    missing: string[];
    status: GoogleAdsConnectionStatus;
    connections: AdConnection[];
  };
}

/** The demo account's facts and state (demoAccountView in @app/core). */
export interface DemoAccount {
  connectionId: string;
  accountId: string;
  name: string;
  currency: string;
  timezone: string;
  country: string;
  accountType: string;
  accountStatus: string;
  authentication: string;
  dataSource: string;
  connectionStatus: string;
  billingStatus: string;
  verification: string;
  isDemo: true;
  connectionType: "demo";
  verificationStatus: "simulated";
  seed: number;
  enabled: boolean;
  status: GoogleAdsConnectionStatus;
  connectedAt: string;
  lastSyncedAt: string | null;
  historyFrom: string | null;
  syncedThrough: string | null;
  syncRequestedAt: string | null;
  permissions: readonly string[];
  badge: string;
  disclaimer: string;
}

export interface AnalyticsAccount {
  id: string;
  accountId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  /** Simulated figures (the demo). */
  demo: boolean;
  connectionType: "demo" | "production";
  verificationStatus: "simulated" | "authorized";
  status: GoogleAdsConnectionStatus;
  lastSyncedAt: string | null;
  historyFrom: string | null;
  syncedThrough: string | null;
  seed: number | null;
}

export type AdsDeltas = { [K in keyof AdsMetrics]: number | null };

/** GET .../ads/google/analytics */
export interface GoogleAdsAnalytics {
  account: AnalyticsAccount;
  range: { from: string; to: string };
  previous: { from: string; to: string; until?: string };
  today: string;
  coverage: { from: string | null; through: string | null; complete: boolean };
  disclaimer: string | null;
  overview: { current: AdsMetrics; previous: AdsMetrics | null; deltas: AdsDeltas };
  series: { day: AdsPeriod[]; week: AdsPeriod[]; month: AdsPeriod[] };
  /** Null without "View campaigns". */
  campaigns: CampaignAnalytics[] | null;
  conversions: { series: ConversionDay[]; top: CampaignAnalytics[] | null };
  devices: DemoBreakdownRow[] | null;
  audience: { age: DemoBreakdownRow[] | null; countries: DemoBreakdownRow[] | null; segments: DemoBreakdownRow[] | null; devices: DemoBreakdownRow[] | null; note: string | null };
  recommendations: Array<AdsRecommendation & { simulated: boolean }> | null;
  combined: { days: DemoStoreDay[]; totals: DemoStoreTotals; note: string } | null;
}

/** GET .../ads/google/analytics/campaigns */
export interface CampaignsAnswer extends CampaignPage {
  account: AnalyticsAccount;
  range: { from: string; to: string };
  disclaimer: string | null;
}

/** Google's campaign types in everyday words (the live report's CHANNEL map, kept in step). */
export const CAMPAIGN_TYPE_LABEL: Record<string, string> = {
  SEARCH: "Search",
  SHOPPING: "Shopping",
  PERFORMANCE_MAX: "Performance Max",
  DISPLAY: "Display",
  VIDEO: "Video",
  DEMAND_GEN: "Demand Gen",
  DISCOVERY: "Discovery",
  MULTI_CHANNEL: "App",
  LOCAL: "Local",
  SMART: "Smart",
};

export const campaignTypeLabel = (type: string | null): string => (type ? (CAMPAIGN_TYPE_LABEL[type] ?? type.toLowerCase().replace(/_/g, " ")) : "—");

export const CAMPAIGN_STATUS_LABEL: Record<string, string> = { ENABLED: "Active", PAUSED: "Paused", REMOVED: "Removed" };
export const campaignStatusLabel = (status: string | null): string => (status ? (CAMPAIGN_STATUS_LABEL[status] ?? status.toLowerCase()) : "—");

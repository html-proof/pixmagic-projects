/**
 * Advertising numbers from Meta Ads and Google Ads, normalized to one shape so the dashboard can
 * add them up and compare them with the store's own sales.
 *
 * Everything here is what the ad platforms report about themselves: "conversions" and their value
 * are the platforms' own attribution, which overlaps between platforms and with Shopify. They are
 * shown as the platforms' claims, never mixed into the store's sales figures.
 */
import { addDays, eachDay } from "./dates";

export const AD_PROVIDERS = ["meta", "google"] as const;
export type AdProvider = (typeof AD_PROVIDERS)[number];

/** One campaign on one day, as stored (ad_campaign_daily). */
export interface AdDayRow {
  provider: AdProvider;
  accountId: string;
  campaignId: string;
  campaignName: string;
  /** The ad account's own calendar day. */
  day: string;
  spend: number;
  impressions: number;
  clicks: number;
  /** Purchases (Meta) or conversions (Google), as the platform counts them. */
  conversions: number;
  conversionValue: number;
  /** Leads from lead forms and lead events (Meta); 0 where the platform has none. */
  leads: number;
}

export interface AdTotals {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  leads: number;
  /** Clicks per impression. */
  ctr: number | null;
  /** Spend per click. */
  cpc: number | null;
  /** Spend per thousand impressions. */
  cpm: number | null;
  /** Spend per conversion. */
  costPerConversion: number | null;
  /** Conversion value per unit of spend ("return on ad spend"). */
  roas: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export function adTotals(rows: AdDayRow[]): AdTotals {
  const t = rows.reduce(
    (a, r) => {
      a.spend += r.spend;
      a.impressions += r.impressions;
      a.clicks += r.clicks;
      a.conversions += r.conversions;
      a.conversionValue += r.conversionValue;
      a.leads += r.leads;
      return a;
    },
    { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0, leads: 0 },
  );
  const spend = r2(t.spend);
  const conversions = Math.round(t.conversions * 100) / 100;
  const cpc = ratio(spend, t.clicks);
  const cpm = ratio(spend * 1000, t.impressions);
  const cpa = ratio(spend, conversions);
  return {
    spend,
    impressions: t.impressions,
    clicks: t.clicks,
    conversions,
    conversionValue: r2(t.conversionValue),
    leads: t.leads,
    ctr: ratio(t.clicks, t.impressions),
    cpc: cpc === null ? null : r2(cpc),
    cpm: cpm === null ? null : r2(cpm),
    costPerConversion: cpa === null ? null : r2(cpa),
    roas: ratio(r2(t.conversionValue), spend),
  };
}

/** One point per day of the range: spend, clicks and conversions, quiet days as zero. */
export function adSeries(rows: AdDayRow[], range: { from: string; to: string }) {
  const by = new Map<string, { spend: number; clicks: number; conversions: number; impressions: number }>();
  for (const r of rows) {
    const d = by.get(r.day) ?? { spend: 0, clicks: 0, conversions: 0, impressions: 0 };
    d.spend += r.spend;
    d.clicks += r.clicks;
    d.conversions += r.conversions;
    d.impressions += r.impressions;
    by.set(r.day, d);
  }
  return eachDay(range.from, range.to).map((day) => {
    const d = by.get(day);
    return { day, spend: r2(d?.spend ?? 0), clicks: d?.clicks ?? 0, impressions: d?.impressions ?? 0, conversions: Math.round((d?.conversions ?? 0) * 100) / 100 };
  });
}

/** Totals per campaign, biggest spend first. */
export function campaignTotals(rows: AdDayRow[], limit = 10) {
  const by = new Map<string, AdDayRow[]>();
  for (const r of rows) {
    const key = `${r.provider}:${r.accountId}:${r.campaignId}`;
    const list = by.get(key) ?? [];
    list.push(r);
    by.set(key, list);
  }
  return [...by.values()]
    .map((list) => {
      // The name the campaign has now: the latest day's.
      const latest = list.reduce((a, r) => (r.day > a.day ? r : a));
      return { provider: latest.provider, accountId: latest.accountId, campaignId: latest.campaignId, name: latest.campaignName, ...adTotals(list) };
    })
    .sort((a, b) => b.spend - a.spend || b.clicks - a.clicks)
    .slice(0, limit);
}

/** The range just before, as many days long (the dashboard's comparison period). */
export function previousRange(range: { from: string; to: string }) {
  const days = eachDay(range.from, range.to).length;
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

/** Meta reports every action type it tracks; these are the ones that mean a purchase or a lead, best first. */
const META_PURCHASE = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"];
const META_LEAD = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];

type MetaAction = { action_type: string; value: string | number };

/**
 * Meta lists overlapping action types for one purchase (omni_purchase includes purchase, which
 * includes the pixel's own): take the first that's present, never the sum, or every sale counts
 * two or three times.
 */
function firstAction(actions: MetaAction[] | undefined, types: string[]): number {
  if (!actions) return 0;
  for (const t of types) {
    const a = actions.find((x) => x.action_type === t);
    if (a) return Number(a.value) || 0;
  }
  return 0;
}

/** One row of GET /act_<id>/insights?level=campaign&time_increment=1. */
export interface MetaInsightRow {
  campaign_id?: string;
  campaign_name?: string;
  date_start: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: MetaAction[];
  action_values?: MetaAction[];
}

export function fromMetaInsight(accountId: string, r: MetaInsightRow): AdDayRow {
  return {
    provider: "meta",
    accountId,
    campaignId: r.campaign_id ?? "account",
    campaignName: r.campaign_name ?? "All campaigns",
    day: r.date_start,
    spend: r2(Number(r.spend ?? 0)),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    conversions: firstAction(r.actions, META_PURCHASE),
    conversionValue: r2(firstAction(r.action_values, META_PURCHASE)),
    leads: Math.round(firstAction(r.actions, META_LEAD)),
  };
}

/** One result of googleAds:searchStream for the campaign query (JSON field names are camelCase). */
export interface GoogleAdsRow {
  campaign?: { id?: string; name?: string };
  segments?: { date?: string };
  metrics?: { costMicros?: string | number; impressions?: string | number; clicks?: string | number; conversions?: string | number; conversionsValue?: string | number };
}

export function fromGoogleAdsRow(accountId: string, r: GoogleAdsRow): AdDayRow | null {
  const day = r.segments?.date;
  if (!day) return null;
  const m = r.metrics ?? {};
  return {
    provider: "google",
    accountId,
    campaignId: String(r.campaign?.id ?? "account"),
    campaignName: r.campaign?.name ?? "All campaigns",
    day,
    // Google reports money in millionths of the account's currency.
    spend: r2(Number(m.costMicros ?? 0) / 1_000_000),
    impressions: Number(m.impressions ?? 0),
    clicks: Number(m.clicks ?? 0),
    conversions: Math.round(Number(m.conversions ?? 0) * 100) / 100,
    conversionValue: r2(Number(m.conversionsValue ?? 0)),
    leads: 0,
  };
}

/** Google shows customer ids as 123-456-7890; the API wants the digits. */
export const googleCustomerId = (id: string) => id.replace(/[^\d]/g, "");
/** Meta ad account ids are "act_<digits>" in the API. */
export const metaAccountId = (id: string) => (id.startsWith("act_") ? id : `act_${id}`);

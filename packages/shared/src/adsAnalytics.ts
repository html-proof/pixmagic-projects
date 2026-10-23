/**
 * The Google Ads analytics page's figures, worked out from stored campaign-days (ad_campaign_daily):
 * the overview's metrics, series by day, week or month, the campaign table (search, sort, filters,
 * pages), budget use, conversion analytics and rule-based recommendations. Pure, and the same for a
 * demo account and a real one: what differs is where the rows came from, which the API says.
 *
 * Every rate is worked out from sums, and a rate whose denominator is zero is null (shown as "—"),
 * never a division error or an infinity.
 */
// Without the ".js" the rest of the package uses: the web app imports this file directly
// (@app/shared/adsAnalytics), and its bundler doesn't map "./dates.js" to dates.ts.
import { addDays, daysBetweenInclusive, eachDay, weekStart } from "./dates";
import type { AdDayRow, GoogleReportMetrics } from "./ads";

const r2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/** The sums every figure here is worked out from. */
export interface AdsSums {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
}

export function adsSums(rows: ReadonlyArray<Pick<AdDayRow, "spend" | "impressions" | "clicks" | "conversions" | "conversionValue">>): AdsSums {
  const t = rows.reduce(
    (a, r) => {
      a.spend += r.spend;
      a.impressions += r.impressions;
      a.clicks += r.clicks;
      a.conversions += r.conversions;
      a.conversionValue += r.conversionValue;
      return a;
    },
    { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 },
  );
  return { spend: r2(t.spend), impressions: t.impressions, clicks: t.clicks, conversions: r2(t.conversions), conversionValue: r2(t.conversionValue) };
}

/**
 * The page's metrics: Google's report metrics (spend, impressions, clicks, CTR, CPC, CPM, conversions,
 * their value, cost per conversion, ROAS) and the conversion rate.
 *
 *   CTR = clicks ÷ impressions · CPC = spend ÷ clicks · conversion rate = conversions ÷ clicks
 *   cost per conversion = spend ÷ conversions · ROAS = conversion value ÷ spend
 *
 * Rates are fractions (0.045, shown as 4.5%); ROAS is a multiple (4 means 4× the spend).
 */
export interface AdsMetrics extends GoogleReportMetrics {
  conversionRate: number | null;
}

export function adsMetrics(rows: ReadonlyArray<Pick<AdDayRow, "spend" | "impressions" | "clicks" | "conversions" | "conversionValue">>): AdsMetrics {
  return metricsOf(adsSums(rows));
}

export function metricsOf(t: AdsSums): AdsMetrics {
  const cpc = ratio(t.spend, t.clicks);
  const cpm = ratio(t.spend * 1000, t.impressions);
  const cpa = ratio(t.spend, t.conversions);
  return {
    spend: r2(t.spend),
    impressions: t.impressions,
    clicks: t.clicks,
    ctr: ratio(t.clicks, t.impressions),
    cpc: cpc === null ? null : r2(cpc),
    cpm: cpm === null ? null : r2(cpm),
    conversions: r2(t.conversions),
    conversionValue: r2(t.conversionValue),
    costPerConversion: cpa === null ? null : r2(cpa),
    roas: ratio(t.conversionValue, t.spend),
    conversionRate: ratio(t.conversions, t.clicks),
  };
}

// ---------------------------------------------------------------------------
// Series: the figures per day, week (Monday to Sunday) or month, every period of the range present.
// ---------------------------------------------------------------------------

export const ADS_GRANULARITIES = ["day", "week", "month"] as const;
export type AdsGranularity = (typeof ADS_GRANULARITIES)[number];

export interface AdsPeriod extends AdsMetrics {
  /** The period's first day (the day itself, the week's Monday, the month's first), clipped to the range. */
  from: string;
  to: string;
  /** "2026-10-19" for a day, "2026-W42" for a week, "2026-10" for a month. */
  key: string;
}

/** The Monday of the week `day` is in (the dashboard's This week starts on it too). */
export { weekStart };

/** ISO week label, "2026-W42". */
export function weekKey(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  // ISO weeks: the week with the year's first Thursday is week 1.
  const target = new Date(d.getTime());
  target.setUTCDate(target.getUTCDate() + 3 - ((target.getUTCDay() + 6) % 7));
  const year = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

/** The periods of [from, to] at `g`: each with its first and last day inside the range. */
export function periodsOf(range: { from: string; to: string }, g: AdsGranularity): Array<{ key: string; from: string; to: string }> {
  if (range.from > range.to) return [];
  if (g === "day") return eachDay(range.from, range.to).map((d) => ({ key: d, from: d, to: d }));
  const out: Array<{ key: string; from: string; to: string }> = [];
  let start = range.from;
  while (start <= range.to) {
    const periodStart = g === "week" ? weekStart(start) : monthStart(start);
    const next = g === "week" ? addDays(periodStart, 7) : addDays(monthStart(addDays(periodStart, 31)), 0);
    const end = addDays(next, -1);
    out.push({ key: g === "week" ? weekKey(periodStart) : periodStart.slice(0, 7), from: start, to: end < range.to ? end : range.to });
    start = next;
  }
  return out;
}

export function adsSeries(rows: ReadonlyArray<AdDayRow>, range: { from: string; to: string }, g: AdsGranularity): AdsPeriod[] {
  const by = new Map<string, AdDayRow[]>();
  for (const r of rows) by.set(r.day, [...(by.get(r.day) ?? []), r]);
  return periodsOf(range, g).map((p) => {
    const mine: AdDayRow[] = [];
    for (const day of eachDay(p.from, p.to)) mine.push(...(by.get(day) ?? []));
    return { ...p, ...adsMetrics(mine) };
  });
}

// ---------------------------------------------------------------------------
// Campaigns: each one's figures for the range, its settings, how much of its budget it used, and how
// its first and second half compare (the trends the recommendations are built on).
// ---------------------------------------------------------------------------

export interface CampaignSettings {
  id: string;
  name: string;
  /** Google's channel type (SEARCH, SHOPPING...) when known. */
  type: string | null;
  /** ENABLED, PAUSED or REMOVED when known. */
  status: string | null;
  startDay: string | null;
  dailyBudget: number | null;
}

export interface CampaignAnalytics extends AdsMetrics {
  id: string;
  name: string;
  type: string | null;
  status: string | null;
  startDay: string | null;
  dailyBudget: number | null;
  /** The days of the range the campaign ran on (had a stored row). */
  activeDays: number;
  /** Its budget for those days (daily budget × active days) and the share of it spent; null without a budget. */
  budget: number | null;
  budgetUse: number | null;
  /** The range's first half against its second: how the campaign is moving. */
  halves: { first: AdsMetrics; second: AdsMetrics } | null;
}

/**
 * Every campaign that has a row in the range, with its settings when `settings` has them (a demo's
 * from the generator, a real account's from the stored name alone). Biggest spend first.
 */
export function campaignAnalytics(rows: ReadonlyArray<AdDayRow>, range: { from: string; to: string }, settings: ReadonlyArray<CampaignSettings> = []): CampaignAnalytics[] {
  const by = new Map<string, AdDayRow[]>();
  for (const r of rows) by.set(r.campaignId, [...(by.get(r.campaignId) ?? []), r]);
  const known = new Map(settings.map((s) => [s.id, s]));
  // A campaign that has settings but no rows in the range (paused before it) is still listed, at zero.
  for (const s of settings) if (!by.has(s.id)) by.set(s.id, []);
  const days = daysBetweenInclusive(range.from, range.to);
  const mid = addDays(range.from, Math.floor(days / 2) - 1);
  return [...by.entries()]
    .map(([id, list]) => {
      const s = known.get(id);
      const latest = list.reduce<AdDayRow | null>((a, r) => (a === null || r.day > a.day ? r : a), null);
      const activeDays = new Set(list.map((r) => r.day)).size;
      const budget = s?.dailyBudget !== null && s?.dailyBudget !== undefined ? r2(s.dailyBudget * activeDays) : null;
      const m = adsMetrics(list);
      const halves = days >= 4 ? { first: adsMetrics(list.filter((r) => r.day <= mid)), second: adsMetrics(list.filter((r) => r.day > mid)) } : null;
      return {
        id,
        name: s?.name ?? latest?.campaignName ?? id,
        type: s?.type ?? null,
        status: s?.status ?? null,
        startDay: s?.startDay ?? null,
        dailyBudget: s?.dailyBudget ?? null,
        activeDays,
        budget,
        budgetUse: budget !== null && budget > 0 ? m.spend / budget : null,
        halves,
        ...m,
      };
    })
    .sort((a, b) => b.spend - a.spend || b.impressions - a.impressions || a.name.localeCompare(b.name));
}

export const CAMPAIGN_SORTS = ["spend", "clicks", "impressions", "conversions", "conversionValue", "roas", "ctr", "cpc", "conversionRate", "name"] as const;
export type CampaignSort = (typeof CAMPAIGN_SORTS)[number];

export interface CampaignQuery {
  /** Matches the campaign's name (case-insensitive, any part). */
  q?: string;
  status?: string;
  type?: string;
  sort?: CampaignSort;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface CampaignPage {
  rows: CampaignAnalytics[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

/** The campaign table's rows for a query: searched, filtered, sorted (nulls last), one page. */
export function pageCampaigns(list: ReadonlyArray<CampaignAnalytics>, query: CampaignQuery = {}): CampaignPage {
  const q = (query.q ?? "").trim().toLowerCase();
  const sort: CampaignSort = query.sort ?? "spend";
  const dir = query.dir ?? (sort === "name" ? "asc" : "desc");
  const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize ?? 10)));
  const filtered = list.filter((c) => (!q || c.name.toLowerCase().includes(q)) && (!query.status || c.status === query.status) && (!query.type || c.type === query.type));
  const sorted = [...filtered].sort((a, b) => {
    if (sort === "name") return dir === "asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
    const x = a[sort];
    const y = b[sort];
    if (x === null && y === null) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    return (dir === "asc" ? x - y : y - x) || a.name.localeCompare(b.name);
  });
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.trunc(query.page ?? 1)));
  return { rows: sorted.slice((page - 1) * pageSize, page * pageSize), total: sorted.length, page, pageSize, pages };
}

// ---------------------------------------------------------------------------
// Recommendations: plain rules over the campaign figures, each saying what it saw. Derived from the
// figures alone, so for a demo account they are derived from simulated data (the page says so).
// ---------------------------------------------------------------------------

export const RECOMMENDATION_CODES = ["high_spend_low_roas", "low_ctr", "rising_cpc", "improving_conversion_rate", "budget_opportunity"] as const;
export type RecommendationCode = (typeof RECOMMENDATION_CODES)[number];

export interface AdsRecommendation {
  code: RecommendationCode;
  /** "attention": something to look into; "opportunity": something going well to build on. */
  severity: "attention" | "opportunity";
  campaignId: string;
  campaignName: string;
  title: string;
  /** What the rule saw, in words. */
  detail: string;
  /** The figures behind it, so the page can show them. */
  figures: Record<string, number | null>;
}

/** The rules' thresholds, named so the page can explain them. */
export const RECOMMENDATION_RULES = {
  /** A campaign with at least this share of the spend and a ROAS under this is "high spend, low return". */
  highSpendShare: 0.15,
  lowRoas: 1.5,
  /** A click-through rate under this, with enough impressions to judge, is low. */
  lowCtr: 0.005,
  lowCtrImpressions: 10_000,
  /** A cost per click up (or a conversion rate up) by this share between the halves of the range is a trend. */
  trendUp: 0.15,
  trendClicks: 100,
  /** A campaign returning at least this, having used at least this share of its budget, could take more. */
  opportunityRoas: 3,
  opportunityBudgetUse: 0.85,
} as const;

const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
const times = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}×`);

export function adsRecommendations(campaigns: ReadonlyArray<CampaignAnalytics>): AdsRecommendation[] {
  const R = RECOMMENDATION_RULES;
  const total = campaigns.reduce((a, c) => a + c.spend, 0);
  const out: AdsRecommendation[] = [];
  for (const c of campaigns) {
    if (c.status === "PAUSED" || c.status === "REMOVED") continue;
    const share = total > 0 ? c.spend / total : 0;
    if (c.spend > 0 && share >= R.highSpendShare && (c.roas === null || c.roas < R.lowRoas)) {
      out.push({
        code: "high_spend_low_roas",
        severity: "attention",
        campaignId: c.id,
        campaignName: c.name,
        title: `${c.name}: high spend, low return`,
        detail: `It takes ${pct(share)} of the spend and returns ${times(c.roas)} in conversion value. Check its targeting, bids and landing pages, or move part of its budget to a campaign that returns more.`,
        figures: { spend: c.spend, shareOfSpend: share, roas: c.roas, conversionValue: c.conversionValue },
      });
    }
    if (c.impressions >= R.lowCtrImpressions && c.ctr !== null && c.ctr < R.lowCtr) {
      out.push({
        code: "low_ctr",
        severity: "attention",
        campaignId: c.id,
        campaignName: c.name,
        title: `${c.name}: few clicks for its impressions`,
        detail: `${pct(c.ctr)} of ${c.impressions.toLocaleString()} impressions were clicked. Its ads or audiences may need refreshing; a brand or awareness campaign is often meant to run this way.`,
        figures: { ctr: c.ctr, impressions: c.impressions, clicks: c.clicks },
      });
    }
    const h = c.halves;
    if (h && h.first.clicks >= R.trendClicks && h.second.clicks >= R.trendClicks) {
      if (h.first.cpc !== null && h.second.cpc !== null && h.second.cpc >= h.first.cpc * (1 + R.trendUp)) {
        out.push({
          code: "rising_cpc",
          severity: "attention",
          campaignId: c.id,
          campaignName: c.name,
          title: `${c.name}: clicks are getting dearer`,
          detail: `The cost per click rose from ${h.first.cpc.toFixed(2)} to ${h.second.cpc.toFixed(2)} between the first and second half of these dates (${pct((h.second.cpc - h.first.cpc) / h.first.cpc)}). More competition, or broader matching: review bids and search terms.`,
          figures: { cpcFirstHalf: h.first.cpc, cpcSecondHalf: h.second.cpc, change: (h.second.cpc - h.first.cpc) / h.first.cpc },
        });
      }
      if (h.first.conversionRate !== null && h.second.conversionRate !== null && h.first.conversionRate > 0 && h.second.conversionRate >= h.first.conversionRate * (1 + R.trendUp)) {
        out.push({
          code: "improving_conversion_rate",
          severity: "opportunity",
          campaignId: c.id,
          campaignName: c.name,
          title: `${c.name}: converting better`,
          detail: `Its conversion rate rose from ${pct(h.first.conversionRate)} to ${pct(h.second.conversionRate)} between the first and second half of these dates. Whatever changed is working; it may be worth more budget.`,
          figures: { conversionRateFirstHalf: h.first.conversionRate, conversionRateSecondHalf: h.second.conversionRate },
        });
      }
    }
    if (c.roas !== null && c.roas >= R.opportunityRoas && c.budgetUse !== null && c.budgetUse >= R.opportunityBudgetUse) {
      out.push({
        code: "budget_opportunity",
        severity: "opportunity",
        campaignId: c.id,
        campaignName: c.name,
        title: `${c.name}: returns well and uses its budget`,
        detail: `It returns ${times(c.roas)} and has spent ${pct(c.budgetUse)} of its budget for these dates. A bigger budget would likely bring more at a similar return.`,
        figures: { roas: c.roas, budgetUse: c.budgetUse, budget: c.budget, spend: c.spend },
      });
    }
  }
  // Attention first, then the biggest spend.
  const spendOf = new Map(campaigns.map((c) => [c.id, c.spend]));
  return out.sort((a, b) => (a.severity === b.severity ? (spendOf.get(b.campaignId) ?? 0) - (spendOf.get(a.campaignId) ?? 0) : a.severity === "attention" ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Conversion analytics: per day, with the rates, and the campaigns that convert most.
// ---------------------------------------------------------------------------

export interface ConversionDay {
  day: string;
  conversions: number;
  conversionValue: number;
  clicks: number;
  spend: number;
  conversionRate: number | null;
  costPerConversion: number | null;
}

export function conversionSeries(rows: ReadonlyArray<AdDayRow>, range: { from: string; to: string }): ConversionDay[] {
  return adsSeries(rows, range, "day").map((d) => ({
    day: d.from,
    conversions: d.conversions,
    conversionValue: d.conversionValue,
    clicks: d.clicks,
    spend: d.spend,
    conversionRate: d.conversionRate,
    costPerConversion: d.costPerConversion,
  }));
}

/** The campaigns with the most conversions, most first. */
export const topConverting = (campaigns: ReadonlyArray<CampaignAnalytics>, limit = 5): CampaignAnalytics[] =>
  [...campaigns].filter((c) => c.conversions > 0).sort((a, b) => b.conversions - a.conversions || b.conversionValue - a.conversionValue).slice(0, limit);

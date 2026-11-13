import {
  coveredPart,
  DEMO_DISCLAIMER,
  googleAdTypeLabel,
  googleCampaignStatus,
  googleChannelLabel,
  googleMatchTypeLabel,
  isGoogleDetailLevel,
  META_ATTRIBUTION_WINDOWS,
  metaAttributionLabel,
  metaObjectiveLabel,
  type AdsPeriod,
  type DemoBreakdownRow,
  type GoogleReportLevel,
  type GoogleReportMetrics,
  type GoogleReportParent,
  type GoogleReportRow,
  type MetaAttributionWindow,
  type MetaReportMetrics,
  type MetaReportParent,
  type MetaReportRow,
  type MetaReportView,
  type MetaWindowPurchases,
} from "@app/shared";
import type { GoogleReport } from "../ads/googleAds.js";
import type { MetaReport } from "../ads/meta.js";
import type { GoogleAdsAnalytics } from "./googleAdsAnalytics.js";

// ---------------------------------------------------------------------------
// The Advertising area's own downloads as CSV tables (written by toCsv): the Meta and Google Ads live
// reports at every level, from the answer the page shows (apps/api/src/routes/ads.ts, format=csv), and
// the Google Ads analytics page's sections (routes/adsGoogleDemo.ts, GET …/analytics/export). A figure
// the platform didn't give, or days nothing is stored for, say so in words, never 0. The demo's files
// start with a row that says they are simulated.
// ---------------------------------------------------------------------------

type Cell = string | number | null;
export interface CsvTable {
  header: string[];
  rows: Cell[][];
}

const NOT_REPORTED = "Not reported";

/** A rate (a fraction) as a percentage with two decimals; a multiple with two. */
const rate = (v: number | null | undefined): Cell => (typeof v === "number" ? Math.round(v * 10_000) / 100 : null);
const times = (v: number | null | undefined): Cell => (typeof v === "number" ? Math.round(v * 100) / 100 : null);
/** A money column's heading names the ad account's currency: "Spend (USD)", "Purchase value (USD; Meta's count, 1-day click)". */
const inCurrency = (currency: string | null) => (label: string) => (!currency ? label : label.includes("(") ? label.replace("(", `(${currency}; `) : `${label} (${currency})`);

/** The first row of a demo's file: what its figures are. */
const simulatedRow = (): Cell[] => ["Simulated data", DEMO_DISCLAIMER];
const note = (text: string): Cell[] => ["Note", text];

/** What a live report's file needs besides the answer: the account's currency and days, and whether it is the demo. */
export interface LiveReportCsvOptions {
  currency: string | null;
  timezone: string | null;
  /** The ad account's today: dates reaching it are still coming in, and the file says so, as the page does. */
  today?: string | null;
  /** Generated figures (the Google Ads demo). */
  demo?: boolean;
}

/** Whether the dates reach the ad account's today, whose figures are still coming in. */
const reachesToday = (until: string, opts: LiveReportCsvOptions) => !!opts.today && until >= opts.today;

type Column<T> = [label: string, cell: (x: T) => Cell];

/**
 * One live report as a table: the top row (the account's, or the campaign's, ad set's or ad group's
 * opened), then every row of the answer, whatever the page's filters show; each object's own facts
 * and the figures. Notes last.
 */
function liveTable<M, R extends M & { id: string; name: string }>(
  report: { since: string; until: string; totals: M; rows: R[]; truncated: boolean },
  spec: { one: string; top: string; describe: Array<Column<R>>; metrics: Array<Column<M>>; demo: boolean; notes: string[] },
): CsvTable {
  const figures = (x: M) => spec.metrics.map(([, cell]) => cell(x));
  const blank = (n: number): Cell[] => Array<Cell>(n).fill(null);
  const header = [spec.one, ...spec.describe.map(([label]) => label), ...spec.metrics.map(([label]) => label)];
  const rows: Cell[][] = [];
  if (spec.demo) rows.push(simulatedRow());
  rows.push([spec.top, ...blank(spec.describe.length), ...figures(report.totals)]);
  for (const r of report.rows) rows.push([r.name, ...spec.describe.map(([, cell]) => cell(r)), ...figures(r)]);
  if (report.truncated) rows.push(note(`Only the ${report.rows.length} that spent most are listed.`));
  for (const n of spec.notes) rows.push(note(n));
  return { header, rows };
}

// ---- Meta Ads

const META_ONE: Record<MetaReportView, string> = { campaign: "Campaign", adset: "Ad set", ad: "Ad", placement: "Placement", device: "Device", country: "Country", age: "Age group", gender: "Gender" };

/** A purchase figure under one fixed window: Not reported where Meta gave none (its count for a cost, its value for a return), as on the page. */
function windowFigure(m: MetaReportMetrics, w: MetaAttributionWindow, key: keyof MetaWindowPurchases): Cell {
  const f = m.byWindow?.[w];
  if (!f || (key === "purchases" || key === "costPerPurchase" ? f.purchases : f.purchaseValue) === null) return NOT_REPORTED;
  return key === "roas" ? times(f.roas) : f[key];
}

/**
 * The Meta Ads report as the page shows it, with every attribution the page can pick at once: purchases
 * by each ad set's own setting, then under 1-day click, 7-day click and 1-day view, each Meta's own count.
 * Reach Meta didn't give is Not reported.
 */
export function metaReportTable(report: MetaReport, parent: MetaReportParent, opts: LiveReportCsvOptions): CsvTable {
  const level = report.level;
  const money = inCurrency(opts.currency);
  const objects = level === "campaign" || level === "adset" || level === "ad";
  const setting = "each ad set's own setting";
  const col = (label: string, cell: (r: MetaReportRow) => Cell): Column<MetaReportRow> => [label, cell];
  const describe: Array<Column<MetaReportRow>> = [
    col("Meta id", (r) => r.id),
    ...(level === "adset" || level === "ad" ? [col("Campaign", (r) => r.campaignName)] : []),
    ...(level === "ad" ? [col("Ad set", (r) => r.adsetName)] : []),
    // Meta's own word (ACTIVE, PAUSED, WITH_ISSUES...), as it lists the object now: not for the dates.
    ...(objects ? [col("Status at Meta now", (r) => r.status)] : []),
    ...(level === "campaign" ? [col("Objective", (r) => metaObjectiveLabel(r.details?.objective))] : []),
    ...(level === "campaign" || level === "adset" ? [col(money("Daily budget now"), (r) => r.details?.dailyBudget ?? null), col(money("Lifetime budget now"), (r) => r.details?.lifetimeBudget ?? null)] : []),
    col("Attribution setting", (r) => metaAttributionLabel(r.attribution)),
  ];
  const metrics: Array<Column<MetaReportMetrics>> = [
    [money("Spend"), (m) => m.spend],
    ["Impressions", (m) => m.impressions],
    ["Reach", (m) => m.reach ?? NOT_REPORTED],
    ["Frequency", (m) => (m.reach === null ? NOT_REPORTED : m.frequency)],
    ["Clicks (all)", (m) => m.clicks],
    ["Link clicks", (m) => m.linkClicks],
    ["Link click rate (%)", (m) => rate(m.linkCtr)],
    [money("Cost per link click"), (m) => m.costPerLinkClick],
    [money("Cost per 1,000 impressions"), (m) => m.cpm],
    ["Landing page views (Meta's count)", (m) => m.landingPageViews],
    [money("Cost per landing page view"), (m) => m.costPerLandingPageView],
    [`Purchases (Meta's count, ${setting})`, (m) => m.purchases],
    [money(`Purchase value (Meta's count, ${setting})`), (m) => m.purchaseValue],
    [money(`Cost per purchase (${setting})`), (m) => m.costPerPurchase],
    [`Purchase ROAS (${setting})`, (m) => times(m.roas)],
    ...META_ATTRIBUTION_WINDOWS.flatMap((w): Array<Column<MetaReportMetrics>> => {
      const label = metaAttributionLabel(w) ?? w;
      return [
        [`Purchases (Meta's count, ${label})`, (m) => windowFigure(m, w, "purchases")],
        [money(`Purchase value (Meta's count, ${label})`), (m) => windowFigure(m, w, "purchaseValue")],
        [money(`Cost per purchase (${label})`), (m) => windowFigure(m, w, "costPerPurchase")],
        [`Purchase ROAS (${label})`, (m) => windowFigure(m, w, "roas")],
      ];
    }),
  ];
  const whole = parent.adset !== undefined ? "ad set" : parent.campaign !== undefined ? "campaign" : "ad account";
  return liveTable(report, {
    one: META_ONE[level],
    top: `Whole ${whole}`,
    describe,
    metrics,
    demo: !!opts.demo,
    notes: [
      `Meta's figures for ${report.since} to ${report.until}${opts.timezone ? `, days in the ad account's time zone (${opts.timezone})` : ""}, as Meta reported them.`,
      ...(reachesToday(report.until, opts) ? ["Today's numbers are still coming in: Meta updates them through the day, and can revise purchases for some days afterwards."] : []),
      `Reach counts each person once over the dates, so the rows don't add up to the ${whole}'s reach.`,
      "Purchases and purchase value are Meta's own count of sales it credits to the ads, under the attribution each column names: not Shopify orders, and never added to the store's sales. Not reported: no figure from Meta under that window (Meta refused the windows for this read, or its figure couldn't be read).",
      ...(report.rows.length === 0 ? [`Nothing in this ${whole} was shown to anyone in these dates.`] : []),
    ],
  });
}

// ---- Google Ads

const GOOGLE_ONE: Record<GoogleReportLevel, string> = {
  campaign: "Campaign",
  ad_group: "Ad group",
  device: "Device",
  country: "Country",
  asset_group: "Asset group",
  ad: "Ad",
  keyword: "Keyword",
  search_term: "Search term",
};

/** Whose count the conversions are: Google's, or for the demo, whose figures nobody counted, simulated. */
const counted = (demo: boolean) => (demo ? "simulated" : "Google's count");

/** Google's figures, as its report and the analytics page show them (every conversion action, Google's own count; the demo's simulated). */
const googleFigures = (demo: boolean): Array<[label: string, key: keyof GoogleReportMetrics, kind: "money" | "count" | "rate" | "times"]> => [
  ["Spend", "spend", "money"],
  ["Impressions", "impressions", "count"],
  ["Clicks", "clicks", "count"],
  ["Click-through rate (%)", "ctr", "rate"],
  ["Cost per click", "cpc", "money"],
  ["Cost per 1,000 impressions", "cpm", "money"],
  [`Conversions (${counted(demo)}, all conversion actions)`, "conversions", "count"],
  ["Conversion rate (%)", "conversionRate", "rate"],
  ["Cost per conversion", "costPerConversion", "money"],
  [`Conversion value (${counted(demo)})`, "conversionValue", "money"],
  ["Conversion value / cost", "roas", "times"],
];
const figure = (kind: ReturnType<typeof googleFigures>[number][2], v: number | null): Cell => (kind === "rate" ? rate(v) : kind === "times" ? times(v) : v);
const googleMetrics = (money: (label: string) => string, demo: boolean): Array<Column<GoogleReportMetrics>> =>
  googleFigures(demo).map(([label, key, kind]): Column<GoogleReportMetrics> => [kind === "money" ? money(label) : label, (m) => figure(kind, m[key])]);

/** The top row's name, as the page writes it: the account's, or what an opened campaign or ad group adds up to. */
function googleTop(level: GoogleReportLevel, parent: GoogleReportParent): string {
  if (parent.campaign === undefined && parent.adGroup === undefined) return "Whole ad account";
  const scope = parent.adGroup !== undefined ? "ad group" : "campaign";
  if (isGoogleDetailLevel(level)) return `Whole ${scope}`;
  return `All ${level === "asset_group" ? "asset groups" : level === "ad" ? "ads" : "ad groups"} in this ${scope}`;
}

/** The Google Ads report as the page shows it: each row's facts (status and delivery now, budgets, types, match type, Quality Score), then Google's figures. */
export function googleReportTable(report: GoogleReport, parent: GoogleReportParent, opts: LiveReportCsvOptions): CsvTable {
  const level = report.level;
  const money = inCurrency(opts.currency);
  const demo = !!opts.demo;
  // The demo's facts are generated too: nothing is "at Google" or rated by it.
  const atGoogle = (what: string) => (demo ? `${what} now (simulated)` : `${what} at Google now`);
  const under = level !== "campaign" && level !== "device" && level !== "country";
  const col = (label: string, cell: (r: GoogleReportRow) => Cell): Column<GoogleReportRow> => [label, cell];
  const describe: Array<Column<GoogleReportRow>> = [
    col("Google id", (r) => r.id),
    ...(under ? [col("Campaign", (r) => r.campaignName)] : []),
    ...(level === "ad" || level === "keyword" ? [col("Ad group", (r) => r.adGroupName)] : []),
    ...(level === "campaign" || level === "search_term" ? [col("Campaign type", (r) => googleChannelLabel(r.channel))] : []),
    // Google's own word (ENABLED, PAUSED, REMOVED), and a campaign's delivery as Google rates it: now, not for the dates.
    ...(level !== "device" && level !== "country" && level !== "search_term" ? [col(atGoogle("Status"), (r) => r.status)] : []),
    ...(level === "campaign"
      ? [
          col(atGoogle("Delivery"), (r) => googleCampaignStatus(r.primaryStatus, r.primaryStatusReasons)?.label ?? null),
          col("Why", (r) => googleCampaignStatus(r.primaryStatus, r.primaryStatusReasons)?.reasons.join("; ") || null),
          col(money("Daily budget now"), (r) => r.dailyBudget),
          col(money("Total budget now"), (r) => r.totalBudget ?? null),
        ]
      : []),
    ...(level === "ad" ? [col("Ad type", (r) => googleAdTypeLabel(r.adType))] : []),
    ...(level === "keyword"
      ? [
          col("Match type", (r) => googleMatchTypeLabel(r.matchType)),
          // Google gives none with too little data: said, never a score.
          col("Quality Score now (1 to 10)", (r) => r.qualityScore ?? (demo ? "Not rated" : "Not rated by Google")),
        ]
      : []),
  ];
  const detail = isGoogleDetailLevel(level);
  const drilled = parent.campaign !== undefined || parent.adGroup !== undefined;
  const scope = parent.adGroup !== undefined ? "ad group" : "campaign";
  const ownRow = demo ? "The top row is the demo's own row for it." : "The top row is Google's own row for it.";
  const rowsOf = level === "asset_group" ? "asset groups" : level === "ad" ? "ads" : "ad groups";
  return liveTable(report, {
    one: GOOGLE_ONE[level],
    top: googleTop(level, parent),
    describe,
    metrics: googleMetrics(money, demo),
    demo,
    notes: [
      demo
        ? `Generated by bizinsights for the Google Ads demo, for ${report.since} to ${report.until}: simulated, nothing read from Google.`
        : `Google's figures for ${report.since} to ${report.until}${opts.timezone ? `, days in the ad account's time zone (${opts.timezone})` : ""}, as Google reported them.`,
      ...(!demo && reachesToday(report.until, opts) ? ["Today's numbers are still coming in: Google takes up to a few hours to report clicks and spend, and longer for conversions."] : []),
      ...(level === "keyword"
        ? [
            drilled
              ? // One campaign's or ad group's keywords (a Search campaign's): what its row has beyond them is search traffic without a keyword.
                `${ownRow} Spend in this ${scope} without a keyword (dynamic search ads, AI Max keyword-free matching, or a campaign type with no keywords) is in the top row but in none of these rows.`
              : `${ownRow} Keywords belong to Search campaigns, so spend without a keyword (Shopping, Performance Max, Display, YouTube) is in the top row but in none of these rows.`,
          ]
        : level === "search_term"
          ? [`${ownRow} Google lists only the terms enough people searched, and other placements have none, so the terms add up to less than the top row.`]
          : drilled
            ? [`The top row adds up every row ${demo ? "the demo has" : "Google reported"} for these dates (not ${demo ? "the demo's" : "Google's"} own row for it).`]
            : []),
      demo
        ? "Conversions and their value are simulated, standing for what Google counts: every conversion action it's set to count (purchases, and also leads, sign-ups or calls). Not Shopify orders, and never added to the store's sales."
        : "Conversions and their value are Google's own count of every conversion action it's set to count (purchases, and also leads, sign-ups or calls): not Shopify orders, and never added to the store's sales.",
      // Down from a campaign or an ad group the top row is these rows added up: none listed says nothing of whether
      // the campaign itself ran. The whole account's top row is its own, so nothing there means nothing ran.
      ...(report.rows.length === 0 && !detail
        ? [
            drilled
              ? `${demo ? "The demo has" : "Google reported"} no ${rowsOf} with any activity in this ${scope} for these dates.`
              : report.totals.impressions === 0 && report.totals.spend === 0
                ? "Nothing in this ad account was shown to anyone in these dates."
                : level === "ad_group"
                  ? "No ad groups had any activity in these dates: Performance Max campaigns have no ad groups, so their spend is in the top row."
                  : `${demo ? "The demo has" : "Google has"} no split at this level for these dates; the account's activity is in the top row.`,
          ]
        : []),
    ],
  });
}

// ---- The Google Ads analytics page (one connection, from its stored days)

/** The analytics page's sections as downloads, each with whether it needs the campaigns ("View campaigns"). */
export const GOOGLE_ANALYTICS_PARTS = {
  overview: { label: "Overview", campaigns: false },
  campaigns: { label: "Campaigns", campaigns: true },
  days: { label: "Spending and conversions by day", campaigns: false },
  weeks: { label: "Spending and conversions by week", campaigns: false },
  months: { label: "Spending and conversions by month", campaigns: false },
  devices: { label: "Devices", campaigns: false },
  audience: { label: "Audience", campaigns: false },
  recommendations: { label: "Recommendations", campaigns: true },
  combined: { label: "Demo store and ad spend", campaigns: false },
} as const satisfies Record<string, { label: string; campaigns: boolean }>;
export type GoogleAnalyticsPart = keyof typeof GOOGLE_ANALYTICS_PARTS;
export const GOOGLE_ANALYTICS_PART_IDS = Object.keys(GOOGLE_ANALYTICS_PARTS) as GoogleAnalyticsPart[];

/** A day, week or month with no stored figures says so; one partly stored, which days. */
function periodRow(p: AdsPeriod, a: GoogleAdsAnalytics, metrics: Array<Column<GoogleReportMetrics>>): Cell[] {
  const covered = coveredPart(a.coverage, p);
  if (!covered) return [p.key, p.from, p.to, "Not stored", ...Array<Cell>(metrics.length - 1).fill(null), "No figures are stored for these days."];
  const notes = [
    covered.from !== p.from || covered.to !== p.to ? `Only ${covered.from} to ${covered.to} are stored.` : null,
    p.to >= a.today ? "Still running: its figures keep coming in." : null,
  ].filter(Boolean);
  return [p.key, p.from, p.to, ...metrics.map(([, cell]) => cell(p)), notes.join(" ") || null];
}

/** One split's rows (devices, countries, age groups, audience segments): its share of the spend, then Google's figures. */
const splitRows = (rows: DemoBreakdownRow[], metrics: Array<Column<GoogleReportMetrics>>, kind?: string): Cell[][] =>
  rows.map((r) => [...(kind ? [kind] : []), r.name, rate(r.share), ...metrics.map(([, cell]) => cell(r))]);

/**
 * One section of the Google Ads analytics page as a table, from the same answer the page shows
 * (GoogleAdsAnalytics, with a real account's device and country splits read as the page reads them).
 * Figures come from the stored days: a day the account hasn't stored is Not stored, never 0.
 */
export function googleAnalyticsTable(part: GoogleAnalyticsPart, a: GoogleAdsAnalytics): CsvTable {
  const money = inCurrency(a.account.currency);
  const metrics = googleMetrics(money, !!a.account.demo);
  const rows: Cell[][] = a.account.demo ? [simulatedRow()] : [];
  const covered = coveredPart(a.coverage, a.range);
  const coverage = !covered
    ? "Nothing is stored for this account for these dates yet."
    : covered.from !== a.range.from || covered.to !== a.range.to
      ? `Figures are stored for ${covered.from} to ${covered.to} only: the days outside them aren't counted.`
      : null;
  const out = (header: string[]) => ({ header, rows });
  switch (part) {
    case "overview": {
      const { current } = a.overview;
      for (const [label, key, kind] of googleFigures(!!a.account.demo)) {
        const heading = kind === "money" ? money(label) : label;
        rows.push([heading, covered ? figure(kind, current[key]) : "Not stored", coverage]);
      }
      return out(["Measure", "Value", "Note"]);
    }
    case "campaigns": {
      for (const c of a.campaigns ?? []) {
        rows.push([c.name, c.id, googleChannelLabel(c.type), c.status, c.dailyBudget, c.activeDays, c.budget, rate(c.budgetUse), ...metrics.map(([, cell]) => cell(c))]);
      }
      if (!a.campaigns?.length) rows.push(note("No campaign has figures stored for these dates."));
      if (coverage) rows.push(note(coverage));
      return out(["Campaign", "Google id", "Campaign type", "Status", money("Daily budget"), "Days with figures", money("Budget for those days"), "Budget used (%)", ...metrics.map(([label]) => label)]);
    }
    case "days":
    case "weeks":
    case "months": {
      const series = part === "days" ? a.series.day : part === "weeks" ? a.series.week : a.series.month;
      for (const p of series) rows.push(periodRow(p, a, metrics));
      return out([part === "days" ? "Day" : part === "weeks" ? "Week" : "Month", "From", "To", ...metrics.map(([label]) => label), "Note"]);
    }
    case "devices": {
      if (a.devices) rows.push(...splitRows(a.devices, metrics));
      else rows.push(["Not available", a.audience.note ?? "No device split for this account."]);
      return out(["Device", "Share of spend (%)", ...metrics.map(([label]) => label)]);
    }
    case "audience": {
      const parts: Array<[string, DemoBreakdownRow[] | null]> = [
        ["Age group", a.audience.age],
        ["Country", a.audience.countries],
        ["Audience segment", a.audience.segments],
        ["Device", a.audience.devices],
      ];
      for (const [kind, list] of parts) {
        if (list) rows.push(...splitRows(list, metrics, kind));
        else rows.push([kind, "Not available for this account"]);
      }
      if (a.audience.note) rows.push(note(a.audience.note));
      return out(["Split", "Name", "Share of spend (%)", ...metrics.map(([label]) => label)]);
    }
    case "recommendations": {
      for (const r of a.recommendations ?? []) rows.push([r.severity === "attention" ? "Look into" : "Opportunity", r.campaignName, r.title, r.detail]);
      if (!a.recommendations?.length) rows.push(note("Nothing stands out in these dates."));
      return out(["Kind", "Campaign", "Recommendation", "What it saw"]);
    }
    case "combined": {
      const c = a.combined;
      if (!c) {
        rows.push(["Not available", "Only the Google Ads demo has a simulated store. A real account's spend is set against your store's own sales on the Advertising overview."]);
        return out(["Day", "Note"]);
      }
      for (const d of c.days) rows.push([d.day, d.orders, d.netSales, d.adOrders, d.adSales, d.spend]);
      rows.push(["Total", c.totals.orders, c.totals.netSales, c.totals.adOrders, c.totals.adSales, c.totals.spend]);
      rows.push(note(c.note));
      return out(["Day", "Orders (simulated store)", money("Net sales (simulated store)"), "Orders the demo ads credit to themselves", money("Sales the demo ads credit to themselves"), money("Ad spend")]);
    }
  }
}

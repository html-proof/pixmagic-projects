import { calculationName, customApplied, customSales, DEMO_ACCOUNT_ID, type AccessKey, type SalesCalculation } from "@app/shared";

/**
 * The dashboard sections that can be downloaded as CSV ("Export approved reports"), each with the
 * permissions that let someone see it (any of) and the modules it is built from. Customers' lists
 * are not among them: personal data stays on screen, where it is fetched live and never kept.
 */
export const EXPORT_SECTIONS = {
  sales: { label: "Sales", need: ["analytics.sales"], modules: ["sales_overview"] },
  products: { label: "Products", need: ["products.performance", "products.view"], modules: ["top_products", "catalog"] },
  stock: { label: "Stock", need: ["products.inventory"], modules: ["inventory"] },
  orders: { label: "Recent orders", need: ["orders.list"], modules: ["recent_orders"] },
  discounts: { label: "Discount codes", need: ["discounts.codes"], modules: ["discount_codes"] },
  channels: { label: "Sales channels", need: ["analytics.traffic"], modules: ["channels", "traffic"] },
  timing: { label: "Busiest times", need: ["analytics.behavior"], modules: ["order_timing"] },
  ads: { label: "Advertising", need: ["marketing.ads"], modules: ["ads"] },
  // The Advertising area's reports (apps/web/src/app/(app)/advertising), each what one of its pages shows.
  ads_summary: { label: "Advertising summary", need: ["marketing.ads"], modules: ["ads", "adsense", "sales_overview"] },
  ads_platforms: { label: "Advertising by platform", need: ["marketing.ads"], modules: ["ads"] },
  ads_daily: { label: "Advertising by day", need: ["marketing.ads"], modules: ["ads"] },
  ads_campaigns: { label: "Ad campaigns", need: ["marketing.campaigns"], modules: ["ads"] },
  adsense_daily: { label: "AdSense by day", need: ["marketing.ads"], modules: ["adsense"] },
} as const satisfies Record<string, { label: string; need: readonly AccessKey[]; modules: readonly string[] }>;
export type ExportSection = keyof typeof EXPORT_SECTIONS;
export const EXPORT_SECTION_IDS = Object.keys(EXPORT_SECTIONS) as ExportSection[];

type Cell = string | number | null;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const val = (o: Obj, k: string): Cell => {
  const v = o[k];
  return typeof v === "number" || typeof v === "string" ? v : v === null ? null : null;
};
/** Only the columns whose field this member's copy of the data still has (redactOverview took the rest out). */
function table(rows: Obj[], columns: Array<[label: string, key: string]>) {
  const present = columns.filter(([, k]) => rows.some((r) => k in r));
  return { header: present.map(([label]) => label), rows: rows.map((r) => present.map(([, k]) => val(r, k))) };
}

const num = (o: Obj, k: string) => (typeof o[k] === "number" ? (o[k] as number) : 0);
const linesOf = (d: Obj) => ({ netSales: num(d, "netSales"), additionalFees: num(d, "additionalFees"), duties: num(d, "duties"), shipping: num(d, "shipping"), taxes: num(d, "tax") });

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * One section of a (redacted) dashboard answer as a CSV table. Built from what this member's copy
 * of the data holds, so a field they can't see is not a column.
 */
export function exportTable(section: ExportSection, modules: Obj): { header: string[]; rows: Cell[][] } {
  switch (section) {
    case "sales": {
      const s = isObj(modules.sales_overview) ? modules.sales_overview : {};
      // Shopify's total sales and its lines as they are; the store's own calculation (Custom
      // sales) only as a column of its own, named, when the store shows it on the dashboard.
      const calc = isObj(s.calculation) ? (s.calculation as unknown as SalesCalculation) : null;
      const custom = customApplied(calc) ? calc : null;
      const days = list(s.series).map((d) => (custom && "tax" in d ? { ...d, customSales: customSales(linesOf(d), custom.components) } : d));
      return table(days, [
        ["Day", "day"],
        ["Orders", "orders"],
        ["Total sales", "totalSales"],
        ["Net sales", "netSales"],
        ["Additional fees", "additionalFees"],
        ["Duties", "duties"],
        ["Shipping charges", "shipping"],
        ["Taxes", "tax"],
        ...(custom ? [[`Custom sales (${calculationName(custom)})`, "customSales"] as [string, string]] : []),
        ["Average order value", "averageOrderValue"],
        ["Returns", "refunds"],
      ]);
    }
    case "products": {
      const top = isObj(modules.top_products) ? list(modules.top_products.items) : [];
      const vendors = isObj(modules.catalog) ? list(modules.catalog.topVendors) : [];
      const rows: Cell[][] = [...top.map((p) => ["Product", val(p, "title"), val(p, "units"), val(p, "revenue")]), ...vendors.map((v) => ["Vendor", val(v, "vendor"), val(v, "units"), val(v, "revenue")])];
      return { header: ["Kind", "Name", "Units sold", "Revenue"], rows };
    }
    case "stock": {
      const inv = isObj(modules.inventory) ? modules.inventory : {};
      return table(list(inv.lowStockItems), [
        ["Product", "productTitle"],
        ["Variant", "variantTitle"],
        ["SKU", "sku"],
        ["In stock", "quantity"],
        ["Sold per day", "dailySales"],
        ["Days of cover", "daysOfCover"],
      ]);
    }
    case "orders": {
      const rows = isObj(modules.recent_orders) ? list(modules.recent_orders.items) : [];
      const out = table(rows, [
        ["Order", "name"],
        ["Date", "createdAt"],
        ["Total", "total"],
        ["Items", "units"],
        ["Channel", "channel"],
        ["Payment status", "financialStatus"],
        ["Fulfillment status", "fulfillmentStatus"],
        ["Cancelled", "cancelled"],
      ]);
      const cancelled = out.header.indexOf("Cancelled");
      if (cancelled >= 0) out.rows = rows.map((r, i) => out.rows[i]!.map((c, j) => (j === cancelled ? (r.cancelled === true ? "yes" : "no") : c)));
      return out;
    }
    case "discounts":
      return table(isObj(modules.discount_codes) ? list(modules.discount_codes.items) : [], [
        ["Code", "code"],
        ["Orders", "orders"],
        ["Discount given", "discount"],
        ["Sales", "sales"],
      ]);
    case "channels": {
      const ch = isObj(modules.channels) ? list(modules.channels.items) : [];
      const tr = isObj(modules.traffic) ? list(modules.traffic.items) : [];
      const rows: Cell[][] = [...ch.map((c) => ["Sales channel", val(c, "label"), val(c, "orders"), val(c, "sales")]), ...tr.map((t) => ["Traffic source", val(t, "label"), val(t, "orders"), val(t, "sales")])];
      return { header: ["Kind", "Name", "Orders", "Sales"], rows };
    }
    case "timing": {
      const t = isObj(modules.order_timing) ? modules.order_timing : {};
      const days = Array.isArray(t.byWeekday) ? (t.byWeekday as number[]) : [];
      const hours = Array.isArray(t.byHour) ? (t.byHour as number[]) : [];
      return {
        header: ["Kind", "When", "Orders"],
        rows: [...days.map((n, i): Cell[] => ["Day", WEEKDAYS[i] ?? String(i), n]), ...hours.map((n, h): Cell[] => ["Hour", `${String(h).padStart(2, "0")}:00`, n])],
      };
    }
    case "ads": {
      const a = isObj(modules.ads) ? modules.ads : {};
      const campaigns = list(a.campaigns);
      if (!campaigns.length) return platformTable(list(a.byProvider));
      // A campaign whose account's figures stop before the range ends adds up only the days stored.
      // The Google Ads demo's campaigns are named as simulated, as everywhere its figures show.
      const out = table(campaigns.map((c) => ({ ...c, provider: platformName(c.provider, c.accountId === DEMO_ACCOUNT_ID) })), [...AD_COLUMNS, ["Complete", "complete"]]);
      const complete = out.header.indexOf("Complete");
      if (complete >= 0) out.rows = campaigns.map((c, i) => out.rows[i]!.map((cell, j) => (j === complete ? (c.complete === false ? "no" : "yes") : cell)));
      return out;
    }
    case "ads_summary":
      return summaryTable(isObj(modules.ads) ? modules.ads : null, isObj(modules.adsense) ? modules.adsense : null);
    case "ads_platforms":
      return platformTable(isObj(modules.ads) ? list(modules.ads.byProvider) : []);
    case "ads_daily": {
      const a = isObj(modules.ads) ? modules.ads : {};
      const demo = a.demo === true;
      const rows: Cell[][] = [];
      for (const p of list(a.seriesByProvider)) {
        for (const d of list(p.series)) {
          // A day the platform's accounts have no figures for says so: never a 0.
          if (d.spend === null) rows.push([val(d, "day"), platformName(p.provider, demo && p.provider === "google"), "No figures", null, null, null, null, null]);
          else rows.push([val(d, "day"), platformName(p.provider, demo && p.provider === "google"), val(d, "spend"), val(d, "impressions"), val(d, "clicks"), val(d, "linkClicks"), val(d, "purchases"), val(d, "purchaseValue")]);
        }
      }
      rows.sort((x, y) => String(x[0]).localeCompare(String(y[0])));
      return { header: ["Day", "Platform", "Spend", "Impressions", "Clicks (all)", "Link clicks", "Purchases (platform's count)", "Purchase value (platform's count)"], rows };
    }
    case "ads_campaigns": {
      const a = isObj(modules.ads) ? modules.ads : {};
      const campaigns = list(a.campaigns);
      // The status is the platform's own word (ENABLED, PAUSED, ACTIVE, ARCHIVED...), as of the account's last sync; empty: not read yet.
      const header = ["Platform", "Account", "Campaign", "Status", ...AD_COLUMNS.slice(2).map(([label]) => label), "Spend before", "Spend change (%)", "ROAS before", "ROAS change (%)", "Complete"];
      const rows = campaigns.map((c): Cell[] => {
        const change = isObj(c.change) ? c.change : null;
        const before = change && isObj(change.previous) ? change.previous : {};
        const deltas = change && isObj(change.deltas) ? change.deltas : {};
        return [
          platformName(c.provider, c.accountId === DEMO_ACCOUNT_ID),
          val(c, "accountId"),
          val(c, "name"),
          val(c, "status"),
          ...AD_COLUMNS.slice(2).map(([, k]) => val(c, k)),
          change ? val(before, "spend") : null,
          change ? pct(deltas.spend) : null,
          change ? val(before, "roas") : null,
          change ? pct(deltas.roas) : null,
          c.complete === false ? "no" : "yes",
        ];
      });
      return { header, rows };
    }
    case "adsense_daily": {
      const s = isObj(modules.adsense) ? modules.adsense : {};
      const rows = list(s.series).map((d): Cell[] => (d.earnings === null ? [val(d, "day"), "No figures", null, null, null] : [val(d, "day"), val(d, "earnings"), val(d, "pageViews"), val(d, "impressions"), val(d, "clicks")]));
      return { header: ["Day", "Estimated earnings", "Page views", "Impressions", "Clicks"], rows };
    }
  }
}

/** A change (a fraction) as a percentage with one decimal; null when there is none. */
const pct = (v: unknown): Cell => (typeof v === "number" ? Math.round(v * 1000) / 10 : null);

/** Figures as a page shows them: the whole range, or the days so far (dated), or none. */
function shownTotals(fig: Obj): { totals: Obj | null; through: string | null } {
  if (isObj(fig.current)) return { totals: fig.current, through: null };
  const soFar = isObj(fig.soFar) && isObj(fig.soFar.totals) ? fig.soFar : null;
  return soFar ? { totals: soFar.totals as Obj, through: String(soFar.to) } : { totals: null, through: null };
}

const NOT_COMPARED: Record<string, string> = {
  running: "Not compared: the dates are still running.",
  no_history: "Not compared: no earlier data.",
  incomplete: "Not compared: some days are missing.",
};

/**
 * The Advertising overview's figures, one per row: each with the figure compared with and the change,
 * on the same whole days as the page (an ad module's `compared`: while the dates include a day not
 * over yet, both sides stop at the last whole day, so the figure for the days compared is a column of
 * its own beside the whole dates'), or the reason there is none. Spend
 * and the platforms' own counts first, then the store's own sales set against the spend (Shopify's,
 * never the platforms'), then AdSense's estimated earnings, money in, never added to the spend.
 */
function summaryTable(ads: Obj | null, adsense: Obj | null) {
  const rows: Cell[][] = [];
  const unavailable = (fig: Obj) => (isObj(fig.partial) ? `Figures are stored for ${String(fig.partial.from)} to ${String(fig.partial.to)} only.` : "No figures are stored for these dates yet.");
  const add = (fig: Obj, measures: Array<[label: string, key: string, compared: boolean]>) => {
    const { totals, through } = shownTotals(fig);
    const before = isObj(fig.previous) ? fig.previous : {};
    const deltas = isObj(fig.deltas) ? fig.deltas : {};
    const why = typeof fig.notCompared === "string" ? (NOT_COMPARED[fig.notCompared] ?? null) : null;
    const c = isObj(fig.compared) && isObj(fig.compared.current) && isObj(fig.compared.current.totals) ? fig.compared : null;
    const now = c ? (c.current as Obj).totals as Obj : {};
    const days = c && Number(c.trimmed) > 0 ? `Compared through ${String((c.current as Obj).to)}: whole days only.` : null;
    for (const [label, key, compared] of measures) {
      if (!totals) {
        rows.push([label, "Unavailable", null, null, null, unavailable(fig)]);
        continue;
      }
      const on = compared && c;
      const note = [through ? `Up to ${through}: the days after it aren't over yet.` : null, compared ? why : null, on ? days : null].filter(Boolean).join(" ") || null;
      rows.push([label, val(totals, key), on ? val(now, key) : null, on ? val(before, key) : null, on ? pct(deltas[key]) : null, note]);
    }
  };
  if (ads) {
    if (ads.demo === true) rows.push(["Simulated figures", "Includes the Google Ads demo", null, null, null, "Generated by bizinsights, not read from Google, and never set against the store's sales."]);
    add(ads, [
      ["Ad spend", "spend", true],
      ["Impressions", "impressions", false],
      ["Link clicks", "linkClicks", true],
      ["Purchases (platforms' count)", "purchases", true],
      ["Purchase value (platforms' count)", "purchaseValue", true],
      ["Return on ad spend (platforms' own)", "roas", true],
      ["Conversions (all conversion actions)", "conversions", true],
    ]);
    const s = isObj(ads.sales) ? ads.sales : null;
    if (s) {
      const before = isObj(s.previous) ? s.previous : null;
      const deltas = isObj(s.deltas) ? s.deltas : {};
      const why = before ? null : "Not compared: needs whole dates on both sides, with the store's orders imported for them.";
      for (const [label, key] of [
        ["Net sales (Shopify)", "netSales"],
        ["Orders (Shopify)", "orders"],
        ["Sales per unit of ad spend (MER)", "salesPerSpend"],
        ["Cost per Shopify order", "costPerOrder"],
      ] as const) {
        // Compared only on whole dates, so the days compared are the dates themselves.
        rows.push([label, val(s, key), before ? val(s, key) : null, before ? val(before, key) : null, before ? pct(deltas[key]) : null, why]);
      }
      rows.push(["Ads as share of sales", val(s, "shareOfSales"), null, null, null, null]);
    }
  }
  if (adsense) add(adsense, [["AdSense estimated earnings (money in, not ad spend)", "earnings", true], ["AdSense page views", "pageViews", true]]);
  return { header: ["Measure", "Value", "Value on the days compared", "Before", "Change (%)", "Note"], rows };
}

/**
 * The ads columns. Clicks are every click the platform counts (Meta's include likes and comments);
 * link clicks are the ones every platform means the same way. Conversions are the platform's own, every
 * conversion action (Google counts leads and calls too); purchases and return on ad spend are purchases only.
 */
const AD_COLUMNS: Array<[label: string, key: string]> = [
  ["Platform", "provider"],
  ["Campaign", "name"],
  ["Spend", "spend"],
  ["Impressions", "impressions"],
  ["Clicks (all)", "clicks"],
  ["Link clicks", "linkClicks"],
  ["Conversions (all conversion actions)", "conversions"],
  ["Conversion value", "conversionValue"],
  ["Purchases", "purchases"],
  ["Purchase value", "purchaseValue"],
  ["Return on ad spend (purchases)", "roas"],
];

const PLATFORM_NAMES: Record<string, string> = { meta: "Meta Ads", google: "Google Ads" };
/** The platform's name; a demo's (the Google Ads demo, docs/ads-demo.md) says it is simulated. */
const platformName = (p: unknown, demo = false) => (typeof p === "string" ? `${PLATFORM_NAMES[p] ?? p}${demo ? " (demo, simulated)" : ""}` : null);

/**
 * Each platform's totals, when the range has no campaign. A platform whose accounts don't have every
 * day of the range stored has no total for it: its cells say "Unavailable" and the note says which days
 * are stored, or, when only days not over yet are missing, the figures up to the last day stored, dated.
 */
function platformTable(platforms: Obj[]) {
  const metrics = AD_COLUMNS.filter(([, k]) => k !== "provider" && k !== "name" && platforms.some((p) => k in p));
  const header = ["Platform", ...metrics.map(([label]) => label), "Complete", "Note"];
  const rows = platforms.map((p): Cell[] => {
    const coverage = isObj(p.coverage) ? p.coverage : {};
    const soFar = isObj(p.soFar) && isObj(p.soFar.totals) ? p.soFar : null;
    const partial = isObj(p.partial) ? p.partial : null;
    const name = platformName(p.provider, p.demo === true);
    if (coverage.complete === true) return [name, ...metrics.map(([, k]) => val(p, k)), "yes", null];
    if (soFar) return [name, ...metrics.map(([, k]) => val(soFar.totals as Obj, k)), `up to ${String(soFar.to)}`, "Up to the last day stored: the days after it aren't over yet."];
    const note = partial ? `Figures are stored for ${String(partial.from)} to ${String(partial.to)} only.` : "No figures are stored for these dates yet.";
    return [name, ...metrics.map((): Cell => "Unavailable"), "no", note];
  });
  return { header, rows };
}

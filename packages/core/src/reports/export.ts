import { calculationName, customApplied, customSales, type AccessKey, type SalesCalculation } from "@app/shared";

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
      const out = table(campaigns.map((c) => ({ ...c, provider: platformName(c.provider) })), [...AD_COLUMNS, ["Complete", "complete"]]);
      const complete = out.header.indexOf("Complete");
      if (complete >= 0) out.rows = campaigns.map((c, i) => out.rows[i]!.map((cell, j) => (j === complete ? (c.complete === false ? "no" : "yes") : cell)));
      return out;
    }
  }
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
const platformName = (p: unknown) => (typeof p === "string" ? (PLATFORM_NAMES[p] ?? p) : null);

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
    const name = platformName(p.provider);
    if (coverage.complete === true) return [name, ...metrics.map(([, k]) => val(p, k)), "yes", null];
    if (soFar) return [name, ...metrics.map(([, k]) => val(soFar.totals as Obj, k)), `up to ${String(soFar.to)}`, "Up to the last day stored: the days after it aren't over yet."];
    const note = partial ? `Figures are stored for ${String(partial.from)} to ${String(partial.to)} only.` : "No figures are stored for these dates yet.";
    return [name, ...metrics.map((): Cell => "Unavailable"), "no", note];
  });
  return { header, rows };
}

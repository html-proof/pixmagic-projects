import type { AdSpendProvider } from "@app/shared/ads";
import { categoryLabel, netProfit, PROFIT_GAP_WORDS, type ProfitGap } from "@app/shared/expenses";
import type { AdAccount, AdsModule, Overview, ProductCostsModule, ProfitModule } from "./types";

// ---------------------------------------------------------------------------
// The costs bizinsights can see for the dates, and net profit when every one is known: worked out
// once here for the home page's profit and expenses panels and for Shopify's gross profit card in
// the sales details, so no two of them say different things. No React: test/profitFigures.test.mjs
// runs it.
// ---------------------------------------------------------------------------

export type CostState = "known" | "loading" | "missing" | "unavailable";
/** Product costs can also be "not_recorded": Shopify's report answered, but no sale had a cost per item. */
export type ProductCostState = CostState | "not_recorded";
/**
 * Ad spend can also be "partial": known for every day in the store's currency, but some accounts
 * report in another currency (`adLeftOut`), so it isn't the whole spend.
 */
export type AdCostState = CostState | "partial";

/** An ad account whose spend isn't in the figures: it reports in another currency. */
export type LeftOutAccount = Pick<AdAccount, "id" | "provider" | "accountId" | "name" | "currency">;

export interface Costs {
  /**
   * The cost of the items sold in the dates: Shopify's cost of goods sold (its profit report, from the
   * cost per item recorded with each sale), or, while that report gives none, the items sold at each
   * product's cost per item in Shopify now (`productSource`).
   */
  productCosts: number | null;
  productState: ProductCostState;
  /** "report": Shopify's profit report; "cost_per_item": each product's cost per item now; null: neither. */
  productSource: "report" | "cost_per_item" | null;
  /** Sales with no cost recorded in Shopify: their cost isn't in `productCosts`. */
  uncosted: number | null;
  /**
   * Ad spend for the whole range, in the store's currency; null while any account lacks a day of it.
   * With `adState` "partial", the accounts in `adLeftOut` aren't in it.
   */
  adSpend: number | null;
  adState: AdCostState;
  /** Ad accounts whose spend isn't in `adSpend` because they report in another currency than the store's. */
  adLeftOut: LeftOutAccount[];
  byProvider: Array<{ provider: AdSpendProvider; spend: number }>;
  /** The owner's own costs for the dates (Settings → Costs); null when this member isn't shown them. */
  yourCosts: number | null;
  /** Their categories, biggest first. */
  yourByCategory: Array<{ label: string; amount: number }>;
}

/**
 * Ads whose spend can be set against the store's sales: the same currency, and no demo account
 * among them (the demo's spend is simulated). Null otherwise.
 */
export function comparableAds(ov: Overview, currency: string): AdsModule | null {
  const ads = ov.modules.ads;
  return ads && ads.accounts.length > 0 && ads.currency === currency && !ads.demo ? ads : null;
}

/**
 * The accounts the ads module left out of its figures, in another currency than its own (`leftOut`,
 * adsFigures in the API; worked out from `accounts` in answers that predate it). Never the demo: its
 * spend is simulated.
 */
export function leftOutOf(ads: AdsModule): LeftOutAccount[] {
  return ads.leftOut ?? ads.accounts.filter((acc) => !acc.counted && !acc.demo);
}

/**
 * The ad accounts whose spend can't be set against the store's sales because it is in another
 * currency than the store's: those the ads module left out, or every one (the demo aside) when the
 * module itself is in another currency.
 */
export function adsLeftOut(ov: Overview, currency: string): LeftOutAccount[] {
  const ads = ov.modules.ads;
  if (!ads) return [];
  return ads.currency === currency ? leftOutOf(ads) : ads.accounts.filter((acc) => !acc.demo);
}

/** "Left out: EU shop (EUR), in another currency.", under an ad spend these accounts aren't in; null with none. */
export function leftOutWords(accounts: readonly LeftOutAccount[]): string | null {
  if (!accounts.length) return null;
  const names = accounts.map((acc) => `${acc.name ?? acc.accountId} (${acc.currency ?? "currency not known yet"})`);
  return `Left out: ${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names)}, in another currency.`;
}

/**
 * Why the Profit sheet's profit and loss takes no ad spend off (ProfitSetup.ads "unusable"): the
 * Google Ads demo's is simulated; the spend is in another currency than the store's (`currency`, null
 * when it is the store's), the accounts left out of it in yet others; or it is in the store's currency
 * but leaves accounts out (`leftOut`), so it isn't the whole spend.
 */
export function adsNotUsableWords(ads: { demo: boolean; currency: string | null; leftOut: readonly LeftOutAccount[] }, storeCurrency: string): string {
  if (ads.demo) return "The Google Ads demo's spend is simulated.";
  if (ads.currency && ads.currency !== storeCurrency) {
    const currencies = [...new Set([ads.currency, ...ads.leftOut.flatMap((acc) => (acc.currency ? [acc.currency] : []))])];
    return `Your ad accounts report in ${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(currencies)}, not ${storeCurrency}.`;
  }
  const left = leftOutWords(ads.leftOut);
  // An answer from before `adsLeftOut` doesn't say which.
  return left ? `${left} Profit needs every account's spend.` : `An ad account reports in another currency than ${storeCurrency}.`;
}

/**
 * Shopify counts a sale with no cost per item at no cost, so a store that records none gets a cost
 * of goods sold of 0 (or none at all) for sales that did cost something. That isn't a cost: it is
 * "not recorded".
 */
function noCostRecorded(c: Pick<NonNullable<ProfitModule["current"]>, "costOfGoodsSold" | "netSalesWithCost" | "netSalesWithoutCost">): boolean {
  return (c.costOfGoodsSold === 0 || c.costOfGoodsSold === null) && !c.netSalesWithCost && c.netSalesWithoutCost !== null && c.netSalesWithoutCost > 0;
}

/**
 * The dates' product costs, or why there are none: Shopify's cost of goods sold while its profit
 * report answers (or is on its way), otherwise the items sold at each product's cost per item
 * (`own`, sent only then).
 */
function productCostsOf(p: ProfitModule | undefined, own: ProductCostsModule | undefined): Pick<Costs, "productCosts" | "productState" | "productSource" | "uncosted"> {
  const c = p?.status === "ready" ? p.current : null;
  if (c && noCostRecorded(c)) return { productCosts: null, productState: "not_recorded", productSource: "report", uncosted: c.netSalesWithoutCost };
  if (c && c.costOfGoodsSold !== null) return { productCosts: c.costOfGoodsSold, productState: "known", productSource: "report", uncosted: c.netSalesWithoutCost };
  const o = own && p?.status !== "loading" ? own.current : null;
  if (o && noCostRecorded(o)) return { productCosts: null, productState: "not_recorded", productSource: "cost_per_item", uncosted: o.netSalesWithoutCost };
  if (o) return { productCosts: o.costOfGoodsSold, productState: "known", productSource: "cost_per_item", uncosted: o.netSalesWithoutCost };
  return { productCosts: null, productState: p?.status === "loading" ? "loading" : p ? "unavailable" : "missing", productSource: null, uncosted: c?.netSalesWithoutCost ?? null };
}

/**
 * The costs of the dates; `adsOn`: advertising is offered and this member is shown it. The ad spend
 * is the accounts in the store's currency; with another account left out it is "partial", never the
 * whole spend.
 */
export function costsOf(ov: Overview, currency: string, adsOn: boolean): Costs {
  const ads = adsOn ? comparableAds(ov, currency) : null;
  const adSpend = ads?.current ? ads.current.spend : null;
  const adLeftOut = adsOn ? adsLeftOut(ov, currency) : [];
  const adState: AdCostState = !adsOn ? "missing" : !ads ? (ov.modules.ads ? "unavailable" : "missing") : adSpend === null ? "unavailable" : adLeftOut.length ? "partial" : "known";
  return {
    ...productCostsOf(ov.modules.profit, ov.modules.product_costs),
    adSpend,
    adState,
    adLeftOut,
    byProvider: ads && adSpend !== null ? ads.byProvider.filter((b) => b.current).map((b) => ({ provider: b.provider, spend: b.current!.spend })) : [],
    yourCosts: ov.modules.expenses?.current.total ?? null,
    yourByCategory: ov.modules.expenses?.current.byCategory.map((c) => ({ label: categoryLabel(c.category, ov.modules.expenses?.categories), amount: c.amount })) ?? [],
  };
}

/**
 * Whether what is left of sales may be called a margin: the cost of what was sold was taken off, as
 * net profit needs it (`netProfit`). Sales less ad spend alone is no margin, nor is it with sales
 * whose cost Shopify doesn't have.
 */
export const marginKnown = (k: Costs) => k.productCosts !== null && !(k.uncosted !== null && k.uncosted > 0);

export interface NetProfit {
  value: number | null;
  gaps: ProfitGap[];
  revenue: number;
}

/**
 * Net profit for the dates (`netProfit` in @app/shared/expenses), or why not. Revenue is total sales
 * less taxes and duties: net sales, shipping and additional fees, the lines a member who may see the
 * owner's costs is shown too. Ad spend: none connected is 0 (other ads are the owner's costs); with an
 * account left out (another currency) it isn't known in full, so there is no net profit. A member not
 * shown the ads, or Shopify's product costs (`costsOn`: Team & Access, `seesModule(access, "profit")`),
 * gets no net profit, which would give them away. Null for a member not shown the owner's costs or
 * those lines.
 */
export function profitOf(ov: Overview, k: Costs, ads: { offered: boolean; shown: boolean }, costsOn: boolean): NetProfit | null {
  const e = ov.modules.expenses;
  const c = ov.modules.sales_overview?.current;
  if (!e || !c || c.shipping === undefined || c.additionalFees === undefined) return null;
  const revenue = Math.round((c.netSales + c.shipping + c.additionalFees) * 100) / 100;
  const adSpend = !ads.offered ? 0 : !ads.shown ? "hidden" : k.adState === "missing" ? 0 : k.adState === "partial" ? null : k.adSpend;
  const productCosts = !costsOn ? "hidden" : k.productState === "not_recorded" ? "not_recorded" : k.productCosts;
  return { ...netProfit({ revenue, productCosts, uncosted: k.uncosted, adSpend, yourCosts: e.current.total, complete: e.complete }), revenue };
}

/**
 * What Shopify's gross profit card (the sales details) says beside Shopify's own figures, from the
 * same costs as Business profit overview. Worked out by the caller, so the card, also loaded with the
 * Shopping Funnel's sessions card, doesn't bring @app/shared/expenses (and zod) to that page.
 */
export interface ProfitCardFigures {
  /** No sale in the dates had a cost recorded: Shopify's cost of goods sold of 0 isn't a cost. */
  noCostRecorded: boolean;
  /** The net profit Business profit overview gives for the same store and dates; null with `netNote` saying why. */
  net: number | null;
  netNote: string;
}

export function profitCardFigures(ov: Overview, currency: string, ads: { offered: boolean; shown: boolean }, costsOn: boolean): ProfitCardFigures {
  const k = costsOf(ov, currency, ads.shown);
  const p = profitOf(ov, k, ads, costsOn);
  return {
    noCostRecorded: k.productState === "not_recorded",
    net: p?.value ?? null,
    netNote: !p
      ? "Net profit needs figures you aren't shown."
      : p.value !== null
        ? "Revenue less product costs, ad spend and your costs, as in Business profit overview."
        : p.gaps.map((g) => PROFIT_GAP_WORDS[g]).join(" "),
  };
}

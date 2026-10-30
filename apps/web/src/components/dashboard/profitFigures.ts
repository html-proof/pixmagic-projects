import type { AdSpendProvider } from "@app/shared/ads";
import { EXPENSE_CATEGORY_LABEL, netProfit, PROFIT_GAP_WORDS, type ProfitGap } from "@app/shared/expenses";
import type { AdsModule, Overview, ProfitModule } from "./types";

// ---------------------------------------------------------------------------
// The costs bizinsights can see for the dates, and net profit when every one is known: worked out
// once here for the home page's profit and expenses panels and for Shopify's gross profit card in
// the sales details, so no two of them say different things. No React: test/profitFigures.test.mjs
// runs it.
// ---------------------------------------------------------------------------

export type CostState = "known" | "loading" | "missing" | "unavailable";
/** Product costs can also be "not_recorded": Shopify's report answered, but no sale had a cost per item. */
export type ProductCostState = CostState | "not_recorded";

export interface Costs {
  /** Shopify's cost of goods sold for the dates (its profit report), from the cost per item recorded with each sale. */
  productCosts: number | null;
  productState: ProductCostState;
  /** Sales with no cost recorded in Shopify: their cost isn't in `productCosts`. */
  uncosted: number | null;
  /** Ad spend for the whole range, in the store's currency; null while any account lacks a day of it. */
  adSpend: number | null;
  adState: CostState;
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
 * Shopify counts a sale with no cost per item at no cost, so a store that records none gets a cost
 * of goods sold of 0 (or none at all) for sales that did cost something. That isn't a cost: it is
 * "not recorded".
 */
function noCostRecorded(c: NonNullable<ProfitModule["current"]>): boolean {
  return (c.costOfGoodsSold === 0 || c.costOfGoodsSold === null) && !c.netSalesWithCost && c.netSalesWithoutCost !== null && c.netSalesWithoutCost > 0;
}

/** Shopify's cost of goods sold as the dates' product costs, or why there is none. */
function productCostsOf(p: ProfitModule | undefined): Pick<Costs, "productCosts" | "productState" | "uncosted"> {
  const c = p?.status === "ready" ? p.current : null;
  const uncosted = c?.netSalesWithoutCost ?? null;
  if (c && noCostRecorded(c)) return { productCosts: null, productState: "not_recorded", uncosted };
  if (c && c.costOfGoodsSold !== null) return { productCosts: c.costOfGoodsSold, productState: "known", uncosted };
  return { productCosts: null, productState: p?.status === "loading" ? "loading" : p ? "unavailable" : "missing", uncosted };
}

/** The costs of the dates; `adsOn`: advertising is offered and this member is shown it. */
export function costsOf(ov: Overview, currency: string, adsOn: boolean): Costs {
  const ads = adsOn ? comparableAds(ov, currency) : null;
  const adSpend = ads?.current ? ads.current.spend : null;
  const adState: CostState = !adsOn ? "missing" : !ads ? (ov.modules.ads ? "unavailable" : "missing") : adSpend !== null ? "known" : "unavailable";
  return {
    ...productCostsOf(ov.modules.profit),
    adSpend,
    adState,
    byProvider: ads && adSpend !== null ? ads.byProvider.filter((b) => b.current).map((b) => ({ provider: b.provider, spend: b.current!.spend })) : [],
    yourCosts: ov.modules.expenses?.current.total ?? null,
    yourByCategory: ov.modules.expenses?.current.byCategory.map((c) => ({ label: EXPENSE_CATEGORY_LABEL[c.category], amount: c.amount })) ?? [],
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
 * owner's costs is shown too. Ad spend: none connected is 0 (other ads are the owner's costs); a
 * member not shown the ads gets no net profit, which would give the spend away. Null for a member
 * not shown the owner's costs or those lines.
 */
export function profitOf(ov: Overview, k: Costs, ads: { offered: boolean; shown: boolean }): NetProfit | null {
  const e = ov.modules.expenses;
  const c = ov.modules.sales_overview?.current;
  if (!e || !c || c.shipping === undefined || c.additionalFees === undefined) return null;
  const revenue = Math.round((c.netSales + c.shipping + c.additionalFees) * 100) / 100;
  const adSpend = !ads.offered ? 0 : !ads.shown ? "hidden" : k.adState === "missing" ? 0 : k.adSpend;
  const productCosts = k.productState === "not_recorded" ? "not_recorded" : k.productCosts;
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

export function profitCardFigures(ov: Overview, currency: string, ads: { offered: boolean; shown: boolean }): ProfitCardFigures {
  const k = costsOf(ov, currency, ads.shown);
  const p = profitOf(ov, k, ads);
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

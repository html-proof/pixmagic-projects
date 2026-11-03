/**
 * Profit and loss (the Profit sheet, docs/kpis.md "Profit and loss"): whether the store made money
 * on a day, in a month or over any run of days, and every step from its sales to its net profit:
 *
 *   revenue          = net sales + shipping and fees charged (total sales less tax and duties)
 *   gross profit     = net sales − product costs (Shopify's own definition)
 *   variable costs   = product costs + the connected ad accounts' spend + your variable costs
 *   fixed costs      = your fixed costs' share of the days (a monthly cost spread over its month)
 *   operating profit = revenue − variable costs − fixed costs
 *   net profit       = operating profit − interest, income tax, depreciation and the like
 *
 * Every input is a figure bizinsights has: the store's sales records day by day, each product's cost
 * per item in Shopify, the ad accounts' daily spend and the owner's own costs (./expenses). Nothing
 * is estimated, and nothing unknown counts as 0: a figure that needs an input bizinsights doesn't
 * have is null, with every reason (`ProfitLossGap`). Net profit here is the dashboard's net profit
 * (netProfit in ./expenses) worked out day by day: the same costs, none counted twice.
 *
 * Money is added up in whole cents; a cost spread over days is rounded to the cent once per run of
 * days (expenseInRange), so a month's column is its costs exactly, whatever its days add up to.
 */
// Extensionless imports: the web app imports this file directly (@app/shared/profit).
import { addDays, periodsOf, type DateRange } from "./dates";
import { addCents, expenseInRange, expensesComplete, totalsOf, type CostOfCategory, type DayFigures, type ExpenseSection, type ExpenseTotals } from "./expenses";

/** One day of the store, as its profit is worked out. */
export interface ProfitDay {
  day: string;
  /** False on a day before the store's imported order history: its sales aren't known (never 0). */
  imported: boolean;
  /** Items at full price, discounts and returns on them: net sales = gross − discounts − returns. */
  grossSales: number;
  discounts: number;
  /** Absent for a member who isn't shown refunds; net sales has them in either way. */
  returns?: number;
  netSales: number;
  /** Shipping and additional fees charged to customers, after their discounts and refunds, before tax. */
  shipping: number;
  additionalFees: number;
  orders: number;
  /** What customers paid, tax and duties included (Shopify's total sales); absent from older answers. */
  totalSales?: number;
  /** Items sold; absent from older answers. */
  units?: number;
  /**
   * The items sold at each product's cost per item in Shopify, and the net sales of items with a
   * cost per item and without one (their cost isn't in `cost`); null when not known for the day.
   */
  products: { cost: number; withCost: number; withoutCost: number } | null;
  /** What the connected ad accounts spent, in the store's currency; null: an account has no figures for the day. */
  adSpend: number | null;
  /** The same by platform (meta, google): each platform's own, null where its accounts have no figures for the day. */
  adSpendBy?: Record<string, number | null>;
}

/** A cost of the owner's list, as the profit figures read it: its terms, category and the section it goes in. */
export type ProfitCost = CostOfCategory;

/** What holds for the store as a whole, whatever the days. */
export interface ProfitSetup {
  /** "known": day by day in `products`; "hidden": this member isn't shown costs; "unavailable": the store doesn't share its products' costs. */
  productCosts: "known" | "hidden" | "unavailable";
  /**
   * "none": no ad account is connected (ads bought elsewhere are among the owner's costs); "known":
   * day by day in `adSpend`; "hidden": this member isn't shown the ads; "unusable": the spend is in
   * another currency than the store's, leaves out an account in another currency, or is the Google
   * Ads demo's (simulated).
   */
  ads: "none" | "known" | "hidden" | "unusable";
  /** The owner's costs (Settings → Costs). */
  costs: readonly ProfitCost[];
  /** The weekdays the store is open, Monday = 0 (empty: every day): recurring costs are spread over those. */
  operatingWeekdays: readonly number[];
  /** From which day the owner says the costs list holds every cost (null: not said). */
  completeFrom: string | null;
}

/**
 * How the ad spend goes into profit (`ProfitSetup.ads`), as the dashboard sets spend against sales:
 * in the store's currency, with no account left out of it in another currency (`leftOut`, the ads
 * module's), and none of it the Google Ads demo's. `ads`: the ads module, null with no ad account
 * connected; `shown`: this member is shown the ads.
 */
export function profitAds(shown: boolean, ads: { demo: boolean; currency: string; leftOut: readonly unknown[] } | null | undefined, storeCurrency: string): ProfitSetup["ads"] {
  if (!shown) return "hidden";
  if (!ads) return "none";
  return ads.demo || ads.currency !== storeCurrency || ads.leftOut.length ? "unusable" : "known";
}

/** Why a profit figure can't be given, each in a word the page explains (PROFIT_LOSS_GAP_WORDS). */
export type ProfitLossGap =
  /** Some days are before the store's imported orders: their sales aren't known. */
  | "sales_not_imported"
  /** The store doesn't share its products' costs with bizinsights. */
  | "product_costs"
  /** The member isn't shown product costs ("View costs and stock value"). */
  | "product_costs_hidden"
  /** No product sold has a cost per item in Shopify. */
  | "no_cost_recorded"
  /** Some products sold have no cost per item in Shopify: the product costs are short. */
  | "uncosted_sales"
  /** An ad account's spend isn't known for every day, or isn't in the store's currency (or is the demo's). */
  | "ad_spend"
  /** The member isn't shown the ad spend. */
  | "ads_hidden"
  /** The owner hasn't said the costs list holds every cost for these days (Settings → Costs). */
  | "costs_not_complete";

export const PROFIT_LOSS_GAP_WORDS: Record<ProfitLossGap, string> = {
  sales_not_imported: "Some of these days are before the orders bizinsights has imported, so their sales aren't known.",
  product_costs: "Product costs come from each product's cost per item in Shopify, which this store doesn't share with bizinsights.",
  product_costs_hidden: "Profit takes off the product costs, which you aren't shown.",
  no_cost_recorded: "None of the products sold has a cost per item in Shopify, so the product costs aren't known.",
  uncosted_sales: "Some products sold have no cost per item in Shopify, so the product costs are short.",
  ad_spend: "A connected ad account's spend isn't known for every day, or isn't in the store's currency.",
  ads_hidden: "Profit takes off the ad spend, which you aren't shown.",
  costs_not_complete: "Your costs list isn't marked complete for these days.",
};

/** A run of days worked out: the sales, every cost, and the profit at each step. */
export interface ProfitLoss {
  from: string;
  to: string;
  days: number;
  /** null when a day's sales aren't known (`sales_not_imported`). */
  grossSales: number | null;
  discounts: number | null;
  /** undefined: not shown to this member. */
  returns: number | null | undefined;
  netSales: number | null;
  shippingAndFees: number | null;
  /** Net sales + shipping and fees: what the store kept from its sales, before any cost (revenue before tax). */
  revenue: number | null;
  /** What customers paid, tax and duties included; null when a day's isn't known. */
  totalSales: number | null;
  /** Taxes and duties collected: total sales − revenue. Collected for governments, never the store's income. */
  taxes: number | null;
  orders: number | null;
  /** Items sold; null when a day's isn't known. */
  units: number | null;
  /** The items sold at their cost per item; null when not known (see the gaps). */
  productCosts: number | null;
  /** Net sales of products with no cost per item in Shopify (their cost isn't in productCosts). */
  uncostedSales: number | null;
  /** The connected ad accounts' spend: 0 with none connected, null when not known. */
  adSpend: number | null;
  /** The same by platform, when the spend is known (each null when that platform's isn't known for every day). */
  adSpendBy: Record<string, number | null>;
  /** Ad spend + your advertising costs (other paid channels, ad spend adjustments); null when the spend isn't known. */
  advertising: number | null;
  /** Product costs + your variable costs, advertising aside; null when the product costs aren't known whole. */
  variableExAds: number | null;
  /** The owner's costs over the days, by category and by group (fixed, variable, below operating profit). */
  yours: ExpenseTotals;
  /** Product costs + ad spend + your variable costs; null when either of the first two isn't known whole. */
  variableCosts: number | null;
  /** Your fixed costs' share of these days. */
  fixedCosts: number;
  /** Interest, income tax, depreciation and the like: between operating and net profit. */
  belowOperating: number;
  /** Every cost: variable (advertising included) + fixed + below operating; null when the variable costs aren't known. */
  totalExpenses: number | null;
  grossProfit: number | null;
  /** Gross profit ÷ net sales. */
  grossMargin: number | null;
  operatingProfit: number | null;
  /** Operating profit ÷ revenue. */
  operatingMargin: number | null;
  netProfit: number | null;
  /** Net profit ÷ revenue. */
  netMargin: number | null;
  /** Marketing expense ratio: advertising ÷ total sales (tax included), as the owner's workbook has it. */
  mer: number | null;
  /** Sitewide return on ad spend: total sales ÷ advertising. */
  roas: number | null;
  /** Variable cost ratio: variable costs (advertising aside) ÷ revenue. */
  vcr: number | null;
  /** Fixed cost ratio: fixed costs ÷ revenue. */
  fcr: number | null;
  /** Revenue less every cost that is known, when profit can't be given: never called profit. */
  afterKnownCosts: number | null;
  /** Why gross profit can't be given (empty when it is). */
  grossGaps: ProfitLossGap[];
  /** Why operating and net profit can't be given (empty when they are). */
  gaps: ProfitLossGap[];
}

const cents = (n: number) => Math.round(n * 100);
const ratio = (a: number | null, b: number | null) => (a === null || b === null || b <= 0 ? null : a / b);

/** The days as runs of consecutive days, in order: a cost spread over days is counted once per run. */
export function runsOf(days: readonly string[]): Array<{ from: string; to: string }> {
  const sorted = [...new Set(days)].sort();
  const runs: Array<{ from: string; to: string }> = [];
  for (const d of sorted) {
    const last = runs.at(-1);
    if (last && addDays(last.to, 1) === d) last.to = d;
    else runs.push({ from: d, to: d });
  }
  return runs;
}

/**
 * The owner's costs over some days (any days: each run of consecutive ones counted whole), spread over
 * the store's open days; those that follow the sales from each day's `figures`.
 */
export function costsOver(costs: readonly ProfitCost[], days: readonly string[], open: readonly number[] = [], figures?: (day: string) => DayFigures | undefined): ExpenseTotals {
  const byCategory = new Map<string, { section: ExpenseSection; cents: number }>();
  const counted = new Set<number>();
  const runs = runsOf(days);
  costs.forEach((e, i) => {
    for (const r of runs) {
      const c = cents(expenseInRange(e, r, open, figures));
      if (c === 0) continue;
      counted.add(i);
      addCents(byCategory, e, c);
    }
  });
  return totalsOf(byCategory, counted.size);
}

/** A day's sales as the costs that follow them read them. */
export const figuresOf = (d: ProfitDay): DayFigures => {
  const revenue = (cents(d.netSales) + cents(d.shipping) + cents(d.additionalFees)) / 100;
  return { totalSales: d.totalSales ?? revenue, revenue, netSales: d.netSales, orders: d.orders, units: d.units ?? 0 };
};

/**
 * The profit and loss of `days` (any days of the store, in any order; usually a day, a month, or the
 * days a filter shows). Every figure is null rather than a part when one of its inputs isn't known.
 */
export function profitAndLoss(days: readonly ProfitDay[], setup: ProfitSetup): ProfitLoss {
  const list = [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const from = list[0]?.day ?? "";
  const to = list.at(-1)?.day ?? "";
  const allImported = list.length > 0 && list.every((d) => d.imported);
  const sum = (pick: (d: ProfitDay) => number) => (allImported ? list.reduce((a, d) => a + cents(pick(d)), 0) / 100 : null);
  const grossSales = sum((d) => d.grossSales);
  const discounts = sum((d) => d.discounts);
  const returns = list.some((d) => d.returns === undefined) ? undefined : sum((d) => d.returns ?? 0);
  const netSales = sum((d) => d.netSales);
  const shippingAndFees = sum((d) => d.shipping + d.additionalFees);
  const revenue = netSales === null || shippingAndFees === null ? null : (cents(netSales) + cents(shippingAndFees)) / 100;
  const totalSales = list.some((d) => d.totalSales === undefined) ? null : sum((d) => d.totalSales!);
  const taxes = totalSales === null || revenue === null ? null : (cents(totalSales) - cents(revenue)) / 100;
  const orders = allImported ? list.reduce((a, d) => a + d.orders, 0) : null;
  const units = allImported && list.every((d) => d.units !== undefined) ? list.reduce((a, d) => a + d.units!, 0) : null;

  // Product costs, and whether every product sold has its cost.
  const grossGaps: ProfitLossGap[] = [];
  if (!allImported) grossGaps.push("sales_not_imported");
  let productCosts: number | null = null;
  let uncostedSales: number | null = null;
  if (setup.productCosts === "hidden") grossGaps.push("product_costs_hidden");
  else if (setup.productCosts === "unavailable" || list.some((d) => d.products === null)) grossGaps.push("product_costs");
  else {
    const p = list.map((d) => d.products!);
    productCosts = p.reduce((a, x) => a + cents(x.cost), 0) / 100;
    uncostedSales = p.reduce((a, x) => a + cents(x.withoutCost), 0) / 100;
    const costed = p.reduce((a, x) => a + cents(x.withCost), 0);
    if (uncostedSales > 0) grossGaps.push(costed === 0 ? "no_cost_recorded" : "uncosted_sales");
  }
  // A product cost that is known but short isn't the product costs.
  const productsWhole = grossGaps.length === 0 ? productCosts : null;
  const grossProfit = grossGaps.length === 0 && netSales !== null && productCosts !== null ? (cents(netSales) - cents(productCosts)) / 100 : null;

  // The connected ad accounts' spend: none connected is none spent through them.
  const gaps: ProfitLossGap[] = [...grossGaps];
  let adSpend: number | null = null;
  if (setup.ads === "none") adSpend = 0;
  else if (setup.ads === "hidden") gaps.push("ads_hidden");
  else if (setup.ads === "unusable" || list.some((d) => d.adSpend === null)) gaps.push("ad_spend");
  else adSpend = list.reduce((a, d) => a + cents(d.adSpend!), 0) / 100;
  const adSpendBy: Record<string, number | null> = {};
  if (adSpend !== null && setup.ads === "known") {
    for (const p of new Set(list.flatMap((d) => Object.keys(d.adSpendBy ?? {})))) {
      adSpendBy[p] = list.every((d) => typeof d.adSpendBy?.[p] === "number") ? list.reduce((a, d) => a + cents(d.adSpendBy![p]!), 0) / 100 : null;
    }
  }

  // The owner's costs, and whether the list holds every one of them for these days.
  const byDay = new Map(list.map((d) => [d.day, d]));
  const figures = (day: string) => {
    const d = byDay.get(day);
    return d && d.imported ? figuresOf(d) : undefined;
  };
  const yours = costsOver(setup.costs, list.map((d) => d.day), setup.operatingWeekdays, figures);
  if (!list.length || !expensesComplete(setup.completeFrom, { from, to })) gaps.push("costs_not_complete");
  const fixedCosts = yours.byGroup.fixed;
  const belowOperating = yours.byGroup.non_operating;
  const variableCosts = productsWhole !== null && adSpend !== null ? (cents(productsWhole) + cents(adSpend) + cents(yours.byGroup.variable)) / 100 : null;
  const advertising = adSpend === null ? null : (cents(adSpend) + cents(yours.bySection.advertising)) / 100;
  const variableExAds = productsWhole === null ? null : (cents(productsWhole) + cents(yours.bySection.variable)) / 100;
  const totalExpenses = variableCosts === null ? null : (cents(variableCosts) + cents(fixedCosts) + cents(belowOperating)) / 100;

  const known = gaps.length === 0 && revenue !== null && variableCosts !== null;
  const operatingProfit = known ? (cents(revenue) - cents(variableCosts) - cents(fixedCosts)) / 100 : null;
  const netProfit = operatingProfit === null ? null : (cents(operatingProfit) - cents(belowOperating)) / 100;
  // What is left after the costs bizinsights knows, while profit can't be given: product costs as far
  // as they are recorded, the spend if known, and every cost of the owner's list.
  const afterKnownCosts = known || revenue === null ? null : (cents(revenue) - cents(productCosts ?? 0) - cents(adSpend ?? 0) - cents(yours.total)) / 100;

  return {
    from,
    to,
    days: list.length,
    grossSales,
    discounts,
    returns,
    netSales,
    shippingAndFees,
    revenue,
    totalSales,
    taxes,
    orders,
    units,
    productCosts,
    uncostedSales,
    adSpend,
    adSpendBy,
    advertising,
    variableExAds,
    yours,
    variableCosts,
    fixedCosts,
    belowOperating,
    totalExpenses,
    grossProfit,
    grossMargin: ratio(grossProfit, netSales),
    operatingProfit,
    operatingMargin: ratio(operatingProfit, revenue),
    netProfit,
    netMargin: ratio(netProfit, revenue),
    mer: ratio(advertising, totalSales),
    roas: ratio(totalSales, advertising),
    vcr: ratio(variableExAds, revenue),
    fcr: ratio(fixedCosts, revenue),
    afterKnownCosts,
    grossGaps,
    gaps,
  };
}

/** Whether a profit is one, a loss, exactly break-even (to the cent), or not known. */
export type ProfitOutcome = "profit" | "loss" | "break_even" | "missing";
export function outcomeOf(n: number | null | undefined): ProfitOutcome {
  if (n === null || n === undefined || !Number.isFinite(n)) return "missing";
  const c = cents(n);
  return c > 0 ? "profit" : c < 0 ? "loss" : "break_even";
}

export const PROFIT_OUTCOME_LABEL: Record<ProfitOutcome, string> = { profit: "Profit", loss: "Loss", break_even: "Break-even", missing: "Missing data" };

/** A calendar month, YYYY-MM. */
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (s: string | null | undefined): s is string => !!s && MONTH.test(s);

/** A month's first and last day; the last is `today` while the month runs (it has no later sales). */
export function monthDays(month: string, today?: string): { from: string; to: string } {
  const from = `${month}-01`;
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const end = `${month}-${String(last).padStart(2, "0")}`;
  return { from, to: today && today >= from && today < end ? today : end };
}

/** How a profit and loss statement lays out its columns: a day, a week (Monday to Sunday), a calendar month or a calendar year each. */
export const STATEMENT_GRAINS = ["day", "week", "month", "year"] as const;
export type StatementGrain = (typeof STATEMENT_GRAINS)[number];
export const isStatementGrain = (s: string | null | undefined): s is StatementGrain => (STATEMENT_GRAINS as readonly string[]).includes(s ?? "");

/** The most columns a statement lays out: a month of days, a year of weeks or months. */
export const MAX_STATEMENT_COLUMNS = 62;

/** Columns when none were picked: days for up to a month, then weeks for up to three, then months. */
export function autoStatementGrain(range: DateRange): StatementGrain {
  const n = Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1;
  return n <= 31 ? "day" : n <= 92 ? "week" : "month";
}

/** The columns of `range` at `grain`, each with its own days inside the range (the first and last may be part of one). */
export function statementPeriods(range: DateRange, grain: StatementGrain): Array<{ key: string; from: string; to: string }> {
  if (grain !== "year") return periodsOf(range, grain);
  const out: Array<{ key: string; from: string; to: string }> = [];
  for (let y = Number(range.from.slice(0, 4)); y <= Number(range.to.slice(0, 4)); y++) {
    const from = `${y}-01-01` < range.from ? range.from : `${y}-01-01`;
    const to = `${y}-12-31` > range.to ? range.to : `${y}-12-31`;
    out.push({ key: String(y), from, to });
  }
  return out;
}

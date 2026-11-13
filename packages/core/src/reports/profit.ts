import type { Store, Tx } from "@app/db";
import {
  addDays,
  autoStatementGrain,
  eachDay,
  expenseTotals,
  localDay,
  MAX_STATEMENT_COLUMNS,
  monthDays,
  operatingDaysBetween,
  profitAds,
  profitAndLoss,
  resolveCapabilities,
  statementPeriods,
  STATEMENT_GRAINS,
  type Comparison,
  type DateRange,
  type ProfitDay,
  type ProfitSetup,
  type StatementGrain,
} from "@app/shared";
import { addMonths } from "@app/shared/customers";
import { expenseLines, expenseTerms } from "../expenses.js";
import { requiredScopesFor, optionalScopesFor } from "../scopes.js";
import { adsModule } from "./ads.js";
import { importedData } from "./catalog.js";
import { r2, type Scope } from "./common.js";
import { productCostsByDay } from "./products.js";
import { dailyRows } from "./sales.js";

/** How many months the profit trend shows, ending with the month asked about. */
export const PROFIT_TREND_MONTHS = 12;

/** What the member asking is shown (Team & Access): each input they aren't is "hidden", never left out silently. */
export interface ProfitSees {
  /** Product costs ("View costs and stock value" with the breakdown: seesModule(access, "product_costs")). */
  productCosts: boolean;
  /** The ad accounts' spend (seesModule(access, "ads")). */
  ads: boolean;
  /** Returns, as a line of their own (finance.refunds); net sales has them in either way. */
  refunds: boolean;
}

type AdsAnswer = Awaited<ReturnType<typeof adsModule>>;

/**
 * Every day of `span` as its profit is worked out, from what bizinsights holds (docs/kpis.md "Profit
 * and loss"):
 *  - the store's sales records day by day (daily_store_metrics), days before its imported order
 *    history marked as such rather than counted as no sales;
 *  - the items sold at each product's cost per item in Shopify (productCostsByDay), when the store
 *    shares its products;
 *  - the connected ad accounts' spend day by day, in all and by platform (the ads module's own
 *    series, `ads`: one answer per run of dates), only when it is the whole spend in the store's
 *    currency: never with an account left out in another currency, nor the Google Ads demo's
 *    (profitAds);
 * and the store's setup: the owner's costs (spread over the days they cover, or the days the store is
 * open when the owner said which), whether product costs and ads are known, hidden or unusable.
 */
async function profitInputs(tx: Tx, store: Store, span: DateRange, now: Date, sees: ProfitSees, adRanges: readonly DateRange[]) {
  const scope: Scope = { ws: store.workspaceId, storeId: store.id };
  const capabilities = resolveCapabilities(store.grantedScopes, { pixelInstalled: store.pixelInstalled, optionalScopes: optionalScopesFor(store), declaredScopes: requiredScopesFor(store) });
  // Each product's cost per item comes with the store's products, as the dashboard's product costs do.
  const productsShared = capabilities.some((c) => c.id === "top_products" && c.enabled);
  const [data, rows, costs, products, ...ads] = await Promise.all([
    importedData(tx, scope, store),
    dailyRows(tx, scope.ws, scope.storeId, span),
    expenseTerms(tx, scope),
    sees.productCosts && productsShared ? productCostsByDay(tx, scope, span) : null,
    // Spend only, whole days; nothing is compared, so the comparison is the day before.
    ...adRanges.map((r) =>
      sees.ads ? adsModule(tx, scope, r, { from: addDays(r.from, -1), to: addDays(r.from, -1) }, store.currency, null, { timeZone: store.timezone, now }) : Promise.resolve(null as AdsAnswer),
    ),
  ]);

  // Ad spend is set against the store's sales only as the dashboard does: in its currency, no account
  // left out of it, none of it the demo's simulated spend. Each run of dates by its own answer.
  const states = ads.map((a) => profitAds(sees.ads, a, store.currency));
  const adsState = states[0] ?? profitAds(sees.ads, null, store.currency);
  const spend = new Map<string, number>();
  const byProvider = new Map<string, Map<string, number>>();
  ads.forEach((a, i) => {
    if (states[i] !== "known" || !a) return;
    for (const d of a.series) if (d.spend !== null && d.spend !== undefined) spend.set(d.day, d.spend);
    for (const p of a.seriesByProvider) {
      const m = byProvider.get(p.provider) ?? new Map<string, number>();
      for (const d of p.series) if (d.spend !== null && d.spend !== undefined) m.set(d.day, d.spend);
      byProvider.set(p.provider, m);
    }
  });
  const providers = [...byProvider.keys()];
  const knownOn = (day: string) => adRanges.some((r, i) => states[i] === "known" && day >= r.from && day <= r.to);
  const setupOf = (state: ProfitSetup["ads"]): ProfitSetup => ({
    productCosts: !sees.productCosts ? "hidden" : productsShared ? "known" : "unavailable",
    ads: state,
    costs: costs.costs,
    operatingWeekdays: costs.operatingWeekdays,
    completeFrom: costs.completeFrom,
  });

  const metrics = new Map(rows.map((r) => [r.day, r]));
  const cost = new Map(products?.map((p) => [p.day, p]) ?? []);
  const days: ProfitDay[] = eachDay(span.from, span.to).map((day) => {
    const r = metrics.get(day);
    const p = cost.get(day);
    const known = knownOn(day);
    return {
      day,
      imported: data.historyFrom !== null && day >= data.historyFrom,
      grossSales: r?.grossSales ?? 0,
      discounts: r?.discounts ?? 0,
      ...(sees.refunds ? { returns: r?.refunds ?? 0 } : {}),
      netSales: r ? r2(r.grossSales - r.discounts - r.refunds) : 0,
      shipping: r?.shipping ?? 0,
      additionalFees: r?.additionalFees ?? 0,
      orders: r?.orders ?? 0,
      totalSales: r?.totalSales ?? 0,
      units: r?.units ?? 0,
      products: p ? { cost: p.costOfGoodsSold, withCost: p.netSalesWithCost, withoutCost: p.netSalesWithoutCost } : null,
      adSpend: known ? (spend.get(day) ?? null) : null,
      ...(known && providers.length ? { adSpendBy: Object.fromEntries(providers.map((pr) => [pr, byProvider.get(pr)!.get(day) ?? null])) } : {}),
    };
  });
  return { data, days, costs, ads, states, adsState, setupOf, providers };
}

/** What the answers say of the ad accounts: the spend's currency when it isn't the store's, the accounts left out, the demo. */
function adsSetup(ads: AdsAnswer, storeCurrency: string) {
  return {
    /** The ad spend's currency when it isn't the store's, for the page to say so; null when it is. */
    adsCurrency: ads && ads.currency !== storeCurrency ? ads.currency : null,
    /**
     * The accounts left out of the spend, in yet another currency (the ads module's `leftOut`): with
     * the spend in the store's currency, the page names them, as the dashboard does.
     */
    adsLeftOut: ads?.leftOut ?? [],
    adsDemo: !!ads?.demo,
  };
}

/**
 * The Profit sheet's profit and loss for one calendar month (docs/kpis.md "Profit and loss"): each of
 * its days, the month as a whole (so far, while it runs), and the 12 months ending with it for the
 * trend, all worked out by `profitAndLoss` (@app/shared/profit) from `profitInputs`. `tx` is a tenant
 * transaction; the caller checked the store is the workspace's and the month isn't in the future.
 */
export async function profitReport(tx: Tx, store: Store, month: string, now: Date, sees: ProfitSees) {
  const today = localDay(now, store.timezone);
  const shown = monthDays(month, today);
  const span = { from: `${addMonths(month, -(PROFIT_TREND_MONTHS - 1))}-01`, to: shown.to };
  const { data, days, ads, adsState, setupOf, costs } = await profitInputs(tx, store, span, now, sees, [span]);
  const setup = setupOf(adsState);

  const inMonth = days.filter((d) => d.day >= shown.from && d.day <= shown.to);
  const whole = monthDays(month);
  const trend = Array.from({ length: PROFIT_TREND_MONTHS }, (_, i) => addMonths(month, i - (PROFIT_TREND_MONTHS - 1))).map((m) => {
    const r = monthDays(m, today);
    return { month: m, ...profitAndLoss(days.filter((d) => d.day >= r.from && d.day <= r.to), setup) };
  });
  return {
    currency: store.currency,
    timezone: store.timezone,
    today,
    month,
    /** The store's first month: the earliest the page offers (null until its first day is known). */
    firstMonth: data.startDay ? data.startDay.slice(0, 7) : null,
    /** The first day with every order imported: the days before it have no sales figure. */
    historyFrom: data.historyFrom,
    setup: {
      productCosts: setup.productCosts,
      ads: setup.ads,
      ...adsSetup(ads[0] ?? null, store.currency),
      operatingWeekdays: setup.operatingWeekdays,
      completeFrom: setup.completeFrom,
      costsCount: setup.costs.length,
    },
    /** The store's own cost categories, for their names. */
    categories: costs.categories,
    /** The month so far (all of it once it has ended). */
    total: profitAndLoss(inMonth, setup),
    /**
     * The whole calendar month's fixed costs and the days they're spread over (its days, or the days
     * the store is open in it): how a day's share is worked out, shown beside it.
     */
    allocation: {
      from: whole.from,
      to: whole.to,
      fixedCosts: expenseTotals(setup.costs, whole, setup.operatingWeekdays).byGroup.fixed,
      days: operatingDaysBetween(whole.from, whole.to, setup.operatingWeekdays),
      calendarDays: operatingDaysBetween(whole.from, whole.to),
    },
    /** Each day of the month so far. */
    days: inMonth.map((d) => profitAndLoss([d], setup)),
    /** The 12 months ending with this one, each so far while it runs. */
    trend,
  };
}

export type ProfitReport = Awaited<ReturnType<typeof profitReport>>;

/** The finest columns that fit MAX_STATEMENT_COLUMNS, from `grain` up. */
function fittingGrain(range: DateRange, grain: StatementGrain): StatementGrain {
  for (const g of STATEMENT_GRAINS.slice(STATEMENT_GRAINS.indexOf(grain))) if (statementPeriods(range, g).length <= MAX_STATEMENT_COLUMNS) return g;
  return "year";
}

/**
 * The Profit & Loss page's statement (docs/kpis.md "Profit and loss"), laid out as the owner's own
 * workbook is: the dates picked as a whole and the dates they're compared with, a column per day,
 * week, month or year (`grain`, or one that fits the dates; never more than MAX_STATEMENT_COLUMNS),
 * each day's figures for the trend, and the owner's costs in the dates a line each (expenseLines).
 * Every figure is `profitAndLoss`'s, from `profitInputs`: nothing is estimated, and a figure an input
 * is missing for is null with its reasons. The comparison is whole days (a running day is compared
 * whole, not up to the same time of day).
 */
export async function profitStatement(tx: Tx, store: Store, dates: { range: DateRange; previous: Comparison }, now: Date, sees: ProfitSees, grain?: StatementGrain | null) {
  const today = localDay(now, store.timezone);
  const range = dates.range;
  const previous = { from: dates.previous.from, to: dates.previous.to };
  const span = { from: previous.from < range.from ? previous.from : range.from, to: previous.to > range.to ? previous.to : range.to };
  const [inputs, lines] = await Promise.all([
    profitInputs(tx, store, span, now, sees, [range, previous]),
    expenseLines(tx, { ws: store.workspaceId, storeId: store.id }, range, today),
  ]);
  const { data, days, costs, ads, states, setupOf, providers } = inputs;
  const setup = setupOf(states[0]!);
  const before = setupOf(states[1]!);
  const within = (r: DateRange) => days.filter((d) => d.day >= r.from && d.day <= r.to);
  const g = fittingGrain(range, grain ?? autoStatementGrain(range));
  const shown = within(range);
  return {
    currency: store.currency,
    timezone: store.timezone,
    today,
    range,
    previous,
    grain: g,
    /** The store's first day (the earliest dates the page offers), and the first with every order imported. */
    firstDay: data.startDay,
    historyFrom: data.historyFrom,
    setup: {
      productCosts: setup.productCosts,
      ads: setup.ads,
      ...adsSetup(ads[0] ?? null, store.currency),
      /** The ad platforms whose spend is counted, for a line each. */
      adProviders: providers,
      operatingWeekdays: setup.operatingWeekdays,
      completeFrom: setup.completeFrom,
      costsCount: setup.costs.length,
    },
    /** The store's own categories, for their names. */
    categories: costs.categories,
    total: profitAndLoss(shown, setup),
    compare: profitAndLoss(within(previous), before),
    columns: statementPeriods(range, g).map((p) => ({ key: p.key, ...profitAndLoss(within(p), setup) })),
    /** Each day's sales, costs and profit, for the trend. */
    daily: shown.map((d) => {
      const pl = profitAndLoss([d], setup);
      return { day: d.day, revenue: pl.revenue, totalExpenses: pl.totalExpenses, netProfit: pl.netProfit, afterKnownCosts: pl.afterKnownCosts };
    }),
    /** The owner's costs in the dates, a line each. */
    lines,
  };
}

export type ProfitStatement = Awaited<ReturnType<typeof profitStatement>>;

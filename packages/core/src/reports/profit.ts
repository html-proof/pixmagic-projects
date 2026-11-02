import type { Store, Tx } from "@app/db";
import {
  addDays,
  eachDay,
  expenseTotals,
  localDay,
  monthDays,
  operatingDaysBetween,
  profitAds,
  profitAndLoss,
  resolveCapabilities,
  type ProfitDay,
  type ProfitSetup,
} from "@app/shared";
import { addMonths } from "@app/shared/customers";
import { expenseTerms } from "../expenses.js";
import { declaredScopes, optionalScopesFor } from "../scopes.js";
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

/**
 * The Profit sheet's profit and loss for one calendar month (docs/kpis.md "Profit and loss"): each of
 * its days, the month as a whole (so far, while it runs), and the 12 months ending with it for the
 * trend, all worked out by `profitAndLoss` (@app/shared/profit) from what bizinsights holds:
 *  - the store's sales records day by day (daily_store_metrics), days before its imported order
 *    history marked as such rather than counted as no sales;
 *  - the items sold at each product's cost per item in Shopify (productCostsByDay), when the store
 *    shares its products;
 *  - the connected ad accounts' spend day by day (the ads module's own series), only when it is the
 *    whole spend in the store's currency: never with an account left out in another currency, nor
 *    the Google Ads demo's (profitAds);
 *  - the owner's costs (Settings → Costs), spread over the days they cover, or the days the store is
 *    open when the owner said which.
 * `tx` is a tenant transaction; the caller checked the store is the workspace's and the month isn't
 * in the future.
 */
export async function profitReport(tx: Tx, store: Store, month: string, now: Date, sees: ProfitSees) {
  const scope: Scope = { ws: store.workspaceId, storeId: store.id };
  const today = localDay(now, store.timezone);
  const shown = monthDays(month, today);
  const span = { from: `${addMonths(month, -(PROFIT_TREND_MONTHS - 1))}-01`, to: shown.to };

  const capabilities = resolveCapabilities(store.grantedScopes, { pixelInstalled: store.pixelInstalled, optionalScopes: optionalScopesFor(store), declaredScopes: declaredScopes() });
  // Each product's cost per item comes with the store's products, as the dashboard's product costs do.
  const productsShared = capabilities.some((c) => c.id === "top_products" && c.enabled);
  const [data, rows, costs, products, ads] = await Promise.all([
    importedData(tx, scope, store),
    dailyRows(tx, scope.ws, scope.storeId, span),
    expenseTerms(tx, scope),
    sees.productCosts && productsShared ? productCostsByDay(tx, scope, span) : null,
    // Spend only, whole days; nothing is compared, so the comparison is the day before.
    sees.ads ? adsModule(tx, scope, span, { from: addDays(span.from, -1), to: addDays(span.from, -1) }, store.currency, null, { timeZone: store.timezone, now }) : null,
  ]);

  // Ad spend is set against the store's sales only as the dashboard does: in its currency, no account
  // left out of it, none of it the demo's simulated spend.
  const adsState = profitAds(sees.ads, ads, store.currency);
  const spend = new Map(ads?.series.map((d) => [d.day, d.spend]) ?? []);
  const setup: ProfitSetup = {
    productCosts: !sees.productCosts ? "hidden" : productsShared ? "known" : "unavailable",
    ads: adsState,
    costs: costs.costs,
    operatingWeekdays: costs.operatingWeekdays,
    completeFrom: costs.completeFrom,
  };

  const metrics = new Map(rows.map((r) => [r.day, r]));
  const cost = new Map(products?.map((p) => [p.day, p]) ?? []);
  const days: ProfitDay[] = eachDay(span.from, span.to).map((day) => {
    const r = metrics.get(day);
    const p = cost.get(day);
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
      products: p ? { cost: p.costOfGoodsSold, withCost: p.netSalesWithCost, withoutCost: p.netSalesWithoutCost } : null,
      adSpend: adsState === "known" ? (spend.get(day) ?? null) : null,
    };
  });

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
      /** The ad spend's currency when it isn't the store's, for the page to say so; null when it is. */
      adsCurrency: ads && ads.currency !== store.currency ? ads.currency : null,
      /**
       * The accounts left out of the spend, in yet another currency (the ads module's `leftOut`): with
       * the spend in the store's currency, the page names them, as the dashboard does.
       */
      adsLeftOut: ads?.leftOut ?? [],
      adsDemo: !!ads?.demo,
      operatingWeekdays: setup.operatingWeekdays,
      completeFrom: setup.completeFrom,
      costsCount: setup.costs.length,
    },
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

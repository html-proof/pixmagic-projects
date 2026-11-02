"use client";
import { useMemo } from "react";
import type { BusinessEvent } from "@app/shared/businessEvents";
import { daysBetweenInclusive } from "@app/shared/dates";
import { dayShown, isSheetGrain, parseEventFilter, parseWeekdays, sheetColumns, sheetRows, sheetTotals, weekdaysParam, type EventFilter, type SheetDay, type SheetGrain } from "@app/shared/sheet";
import type { ProfitSetup } from "@app/shared/profit";
import { seesModule } from "@app/shared/access";
import { useApp } from "@/components/AppContext";
import { useQueryParam } from "@/components/advertising/useAdvertising";
import { useDateRange, type Shown } from "@/components/dashboard/DateRange";
import type { AdsModule, FunnelModule, Overview } from "@/components/dashboard/types";
import { useApi, useLiveApi } from "@/lib/api";

// ---------------------------------------------------------------------------
// What the Profit sheet asks: the dashboard's dates (the same address-bar state as every dashboard
// page), the columns (?by=day|week|month), the days shown (?days=weekends, ?days=0,2,4) and the
// events they're narrowed to (?events=with|without|kind:sale|event:<id>), so a link reproduces the
// view. The figures are the dashboard's own answer narrowed to the sheet (GET …/overview?parts=sheet);
// the events come from GET …/business-events. @app/shared/sheet adds them up.
// ---------------------------------------------------------------------------

/** Orders and visits arrive within a minute: the sheet looks again every minute, as the dashboard does. */
const LIVE_EVERY_MS = 60_000;

const isDaysParam = (v: string): v is string => /^(weekdays|weekends|[0-6](,[0-6]){0,5})$/.test(v);
const isEventsParam = (v: string): v is EventFilter => v !== "all" && parseEventFilter(v) === v;

/** Columns when none were picked: days for up to about six weeks, then weeks, then months. */
export function autoGrain(from: string, to: string): SheetGrain {
  const n = daysBetweenInclusive(from, to);
  return n <= 45 ? "day" : n <= 190 ? "week" : "month";
}

export function useSheet() {
  const { workspace, store, allowed, me, access } = useApp();
  const dates = useDateRange(store?.timezone ?? "UTC", { day: store?.startDay ?? null, created: !!store?.shopCreatedAt });
  const [by, setBy] = useQueryParam("by", isSheetGrain);
  const [daysParam, setDaysParam] = useQueryParam("days", isDaysParam);
  const [events, setEvents] = useQueryParam("events", isEventsParam);
  const weekdays = useMemo(() => parseWeekdays(daysParam), [daysParam]);
  const eventFilter: EventFilter = events ?? "all";

  const base = store ? `/workspaces/${workspace.id}/stores/${store.id}` : null;
  const path = base && dates.asking ? `${base}/overview?${dates.asking.qs}&parts=sheet` : null;
  const live = useLiveApi<Overview>(path, LIVE_EVERY_MS);
  // Never one store's figures under another store's name while switching.
  const ov = live.data && store && live.data.store.id === store.id ? live.data : null;
  const shown: Shown = ov && { range: ov.range, previous: ov.previous, timezone: ov.store.timezone };
  // The events of the dates on screen (the API's own resolved dates, so they always match the columns).
  const eventsPath = base && ov ? `${base}/business-events?from=${ov.range.from}&to=${ov.range.to}` : null;
  const ev = useApi<{ events: BusinessEvent[] }>(eventsPath);
  const list = useMemo(() => ev.data?.events ?? [], [ev.data]);

  const sheet = useMemo(() => {
    const sales = ov?.modules.sales_overview;
    if (!ov || !sales) return null;
    const funnel = ov.modules.funnel as FunnelModule | undefined;
    const ads = ov.modules.ads as AdsModule | undefined;
    const visits = funnel?.visitsByDay ? new Map(funnel.visitsByDay.map((d) => [d.day, d.visits])) : null;
    const providers = ads?.seriesByProvider.map((p) => p.provider) ?? [];
    const spend = new Map(ads?.seriesByProvider.map((p) => [p.provider, new Map(p.series.map((d) => [d.day, d.spend]))]) ?? []);
    const setup = profitSetupOf(ov, allowed("marketing.ads"), seesModule(access, "product_costs"));
    const costs = new Map(ov.modules.product_costs?.byDay?.map((d) => [d.day, d]) ?? []);
    const adDay = new Map(ads?.series.map((d) => [d.day, d.spend]) ?? []);
    const historyFrom = ov.data?.historyFrom ?? null;
    const days: SheetDay[] = sales.series.map((d) => ({
      day: d.day,
      totalSales: d.totalSales,
      tax: d.tax,
      netSales: d.netSales,
      orders: d.orders,
      // An answer from before the field: what average order value was worked out from.
      orderValue: d.orderValue ?? (d.averageOrderValue === null ? 0 : Math.round(d.averageOrderValue * d.orders * 100) / 100),
      newCustomerOrders: d.newCustomerOrders,
      units: d.units,
      ...(visits ? { visits: visits.get(d.day) ?? null } : {}),
      spend: Object.fromEntries(providers.map((p) => [p, spend.get(p)?.get(d.day) ?? null])),
      // The day's profit inputs, for a member shown the breakdown (shipping, fees) and the costs.
      ...(setup && d.grossSales !== undefined && d.discounts !== undefined && d.shipping !== undefined && d.additionalFees !== undefined
        ? {
            profit: {
              day: d.day,
              imported: historyFrom !== null && d.day >= historyFrom,
              grossSales: d.grossSales,
              discounts: d.discounts,
              ...(d.refunds !== undefined ? { returns: d.refunds } : {}),
              netSales: d.netSales,
              shipping: d.shipping,
              additionalFees: d.additionalFees,
              orders: d.orders,
              products: costs.has(d.day) ? { cost: costs.get(d.day)!.costOfGoodsSold, withCost: costs.get(d.day)!.netSalesWithCost, withoutCost: costs.get(d.day)!.netSalesWithoutCost } : null,
              adSpend: setup.ads === "known" ? (adDay.get(d.day) ?? null) : null,
            },
          }
        : {}),
    }));
    // Spend is set against sales only as the dashboard does: in the store's currency, with no demo among the accounts.
    const comparable = !!ads && ads.currency === ov.store.currency && !ads.demo;
    const demo = new Set<string>(ads?.byProvider.filter((p) => p.demo).map((p) => p.provider) ?? []);
    const grain = by ?? autoGrain(ov.range.from, ov.range.to);
    const filter = { weekdays, events: eventFilter };
    const profit = setup && days.every((d) => d.profit) ? setup : undefined;
    const columns = sheetColumns(days, list, grain, filter, profit);
    return {
      days,
      grain,
      columns,
      // The Google Ads demo's simulated spend is named as such, as on its card.
      rows: sheetRows({ comparable, grain, providers, ...(profit ? { profit: { productCosts: profit.productCosts !== "hidden" } } : {}) }).map((r) =>
        r.id.startsWith("spend_") && demo.has(r.id.slice(6)) ? { ...r, label: `${r.label} (demo)` } : r,
      ),
      /** Every day the filter shows, added up: the sheet's first column. */
      total: sheetTotals(
        days.filter((d) => dayShown(d.day, filter, list)),
        profit,
      ),
      /** The store's costs as the profit rows read them; null for a member not shown them. */
      profit: profit ?? null,
      ads: ads ?? null,
      comparable,
      visitsTracked: !!visits,
    };
  }, [ov, list, by, weekdays, eventFilter, allowed, access]);

  return {
    dates,
    shown,
    ov,
    sheet,
    events: list,
    eventsError: ev.error,
    reloadEvents: ev.reload,
    setEventList: (events: BusinessEvent[]) => ev.setData({ events }),
    by,
    setBy,
    weekdays,
    setWeekdays: (days: number[]) => setDaysParam(weekdaysParam(days)),
    eventFilter,
    setEventFilter: (f: EventFilter) => setEvents(f === "all" ? null : f),
    filtered: weekdays.length > 0 || eventFilter !== "all",
    clearFilter: () => {
      setDaysParam(null);
      setEvents(null);
    },
    /** Adding, changing and removing events: whoever sees the sales, signed in to the account (not a shared link). */
    canEdit: allowed("analytics.sales") && !me.shared,
    canExport: allowed("reports.export"),
    error: live.error,
    loading: live.loading,
    checkedAt: live.checkedAt,
    /** The figures on screen are still for the question asked before (new dates loading, or failing to). */
    older: ov !== null && live.dataPath !== path,
    /** Ask again now rather than at the next minute. */
    refresh: () => window.dispatchEvent(new Event("insights:retry")),
  };
}

export type SheetState = ReturnType<typeof useSheet>;

/**
 * What the sheet's profit rows need beside each day's figures (@app/shared/profit): the owner's costs
 * with their terms (the expenses module, with the breakdown permission), whether product costs are
 * known day by day, and the ad spend as the dashboard sets it against sales (the store's currency,
 * every account counted, no demo). Null without the costs.
 */
export function profitSetupOf(ov: Overview, seesAds: boolean, seesProductCosts: boolean): ProfitSetup | null {
  const e = ov.modules.expenses;
  if (!e?.terms) return null;
  const ads = ov.modules.ads as AdsModule | undefined;
  return {
    productCosts: !seesProductCosts ? "hidden" : ov.modules.product_costs?.byDay ? "known" : "unavailable",
    ads: !seesAds ? "hidden" : !ads ? "none" : ads.demo || ads.currency !== ov.store.currency || ads.accounts.some((a) => !a.counted) ? "unusable" : "known",
    costs: e.terms,
    operatingWeekdays: e.operatingWeekdays ?? [],
    completeFrom: e.completeFrom,
  };
}

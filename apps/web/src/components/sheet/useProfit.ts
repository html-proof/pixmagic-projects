"use client";
import { useMemo } from "react";
import type { Expense } from "@app/shared/expenses";
import { isMonth, type ProfitLoss, type ProfitSetup } from "@app/shared/profit";
import { isDay } from "@app/shared/dates";
import { canManage, useApp } from "@/components/AppContext";
import { useQueryParam } from "@/components/advertising/useAdvertising";
import type { LeftOutAccount } from "@/components/dashboard/profitFigures";
import { useApi, useLiveApi } from "@/lib/api";

// ---------------------------------------------------------------------------
// The Profit sheet's profit and loss (GET …/profit?month=; core's profitReport): a month's days, the
// month, and the 12 months ending with it, worked out on the server by @app/shared/profit. The month
// and the day looked at are in the address (?month=2026-11&day=2026-11-02), so a link reproduces
// them; without them, this month and today.
// ---------------------------------------------------------------------------

/** What GET …/profit answers. */
export interface ProfitAnswer {
  currency: string;
  timezone: string;
  today: string;
  month: string;
  firstMonth: string | null;
  historyFrom: string | null;
  setup: {
    productCosts: ProfitSetup["productCosts"];
    ads: ProfitSetup["ads"];
    /** The ad spend's currency when it isn't the store's (answers before `adsLeftOut` gave it either way). */
    adsCurrency: string | null;
    /** The accounts left out of the spend, in another currency (adsNotUsableWords names them). Absent from older answers. */
    adsLeftOut?: LeftOutAccount[];
    adsDemo: boolean;
    operatingWeekdays: number[];
    completeFrom: string | null;
    costsCount: number;
  };
  total: ProfitLoss;
  /** The whole calendar month's fixed costs and the days they're spread over. */
  allocation: { from: string; to: string; fixedCosts: number; days: number; calendarDays: number };
  days: ProfitLoss[];
  trend: Array<ProfitLoss & { month: string }>;
}

/** The costs list (GET …/expenses), for the month's costs and their changes. */
export interface CostsAnswer {
  currency: string;
  today: string;
  expenses: Expense[];
  settings: { completeFrom: string | null; operatingWeekdays: number[]; updatedAt: string | null };
}

/** Orders arrive within a minute: the figures are asked for again every minute, as the sheet's are. */
const LIVE_EVERY_MS = 60_000;

const isMonthParam = (v: string): v is string => isMonth(v);
const isDayParam = (v: string): v is string => isDay(v);

export function useProfit() {
  const { workspace, store, allowed, me } = useApp();
  const [monthParam, setMonthParam] = useQueryParam("month", isMonthParam);
  const [dayParam, setDayParam] = useQueryParam("day", isDayParam);
  // Revenue takes the shipping and fees charged: the sales breakdown's (as the costs list is).
  const sees = allowed("finance.breakdown") && allowed("analytics.sales");
  const base = store ? `/workspaces/${workspace.id}/stores/${store.id}` : null;
  const path = base && sees ? `${base}/profit${monthParam ? `?month=${monthParam}` : ""}` : null;
  const live = useLiveApi<ProfitAnswer>(path, LIVE_EVERY_MS);
  const costs = useApi<CostsAnswer>(base && sees ? `${base}/expenses` : null);
  const data = live.data;

  // The day looked at: the one in the address when it is in the month, else the month's last day so far.
  const day = useMemo(() => {
    if (!data?.days.length) return null;
    return data.days.find((d) => d.from === dayParam) ?? data.days[data.days.length - 1]!;
  }, [data, dayParam]);

  return {
    sees,
    base,
    data,
    /** The figures on screen are for another month than the one asked (it is loading, or failed to). */
    older: data !== null && live.dataPath !== path,
    error: live.error,
    loading: live.loading,
    day,
    month: data?.month ?? monthParam,
    setMonth: (m: string) => {
      setMonthParam(m);
      setDayParam(null);
    },
    setDay: (d: string) => setDayParam(d),
    costs: costs.data,
    costsError: costs.error,
    reloadCosts: costs.reload,
    /** Adding, changing and removing costs: owners and admins, signed in to the account (the API's stores:manage). */
    canManageCosts: canManage(workspace.role) && !me.shared,
  };
}

export type ProfitState = ReturnType<typeof useProfit>;

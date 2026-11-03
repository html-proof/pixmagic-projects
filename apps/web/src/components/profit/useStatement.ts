"use client";
import { useCallback } from "react";
import type { CustomCategory, Expense, ExpenseSection, ExpenseTotals } from "@app/shared/expenses";
import { isStatementGrain, type ProfitLoss, type ProfitSetup, type StatementGrain } from "@app/shared/profit";
import { useApp } from "@/components/AppContext";
import { useQueryParam } from "@/components/advertising/useAdvertising";
import { useDateRange, type Shown } from "@/components/dashboard/DateRange";
import type { LeftOutAccount } from "@/components/dashboard/profitFigures";
import { liveDataChanged, useApi, useLiveApi } from "@/lib/api";

// ---------------------------------------------------------------------------
// What the Profit & Loss page asks (docs/kpis.md "Profit and loss"): the dashboard's dates and their
// comparison (the same address-bar state as every dashboard page), the columns (?grain=day|week|
// month|year), the statement for them (GET …/profit/statement, core's profitStatement, worked out by
// @app/shared/profit), and the store's costs as they're kept (GET …/expenses) for editing them.
// ---------------------------------------------------------------------------

/** One line of the owner's costs in the dates (core's ExpenseLine). */
export interface ExpenseLine {
  key: string;
  expenseId: string;
  kind: "one_time" | "payment" | "rule";
  date: string;
  to: string;
  name: string;
  category: string;
  section: ExpenseSection;
  vendor: string | null;
  paymentMethod: string | null;
  description: string | null;
  note: string | null;
  amount: number;
  scheduledAmount: number | null;
  status: "posted" | "skipped" | "upcoming" | "edited";
}

/** What GET …/profit/statement answers. */
export interface StatementAnswer {
  currency: string;
  timezone: string;
  today: string;
  range: { from: string; to: string };
  previous: { from: string; to: string; compare?: "previous" | "year" | "custom" };
  grain: StatementGrain;
  firstDay: string | null;
  historyFrom: string | null;
  setup: {
    productCosts: ProfitSetup["productCosts"];
    ads: ProfitSetup["ads"];
    adsCurrency: string | null;
    adsLeftOut: LeftOutAccount[];
    adsDemo: boolean;
    adProviders: string[];
    operatingWeekdays: number[];
    completeFrom: string | null;
    costsCount: number;
  };
  categories: CustomCategory[];
  total: ProfitLoss;
  compare: ProfitLoss;
  columns: Array<ProfitLoss & { key: string }>;
  daily: Array<{ day: string; revenue: number | null; totalExpenses: number | null; netProfit: number | null; afterKnownCosts: number | null }>;
  lines: ExpenseLine[];
}

/** A cost as GET …/expenses lists it: with its next payment. */
export type ListedExpense = Expense & { nextDue: string | null };

/** What GET …/expenses answers. */
export interface CostsAnswer {
  currency: string;
  today: string;
  expenses: ListedExpense[];
  categories: CustomCategory[];
  settings: { completeFrom: string | null; operatingWeekdays: number[]; updatedAt: string | null };
  thisMonth: ExpenseTotals & { from: string; to: string };
}

/** Orders arrive within a minute: the statement is asked for again every minute, as the dashboard is. */
const LIVE_EVERY_MS = 60_000;

export function useStatement() {
  const { workspace, store, allowed, me } = useApp();
  const dates = useDateRange(store?.timezone ?? "UTC", { day: store?.startDay ?? null, created: !!store?.shopCreatedAt });
  const [grainParam, setGrain] = useQueryParam("grain", isStatementGrain);
  // Revenue takes the shipping and fees charged: the sales breakdown's (as the costs list is).
  const sees = allowed("finance.breakdown") && allowed("analytics.sales");
  const base = store ? `/workspaces/${workspace.id}/stores/${store.id}` : null;
  const path = base && sees && dates.asking ? `${base}/profit/statement?${dates.asking.qs}${grainParam ? `&grain=${grainParam}` : ""}` : null;
  const live = useLiveApi<StatementAnswer>(path, LIVE_EVERY_MS);
  const costs = useApi<CostsAnswer>(base && sees ? `${base}/expenses` : null);
  const data = live.data;
  const shown: Shown = data && { range: data.range, previous: data.previous, timezone: data.timezone };
  const { reload } = costs;

  /** After a change: the statement and the costs list asked for again. */
  const changed = useCallback(async () => {
    liveDataChanged();
    await reload();
  }, [reload]);

  return {
    sees,
    base,
    dates,
    shown,
    data,
    /** The figures on screen are for other dates than the ones asked (they're loading, or failed to). */
    older: data !== null && live.dataPath !== path,
    error: live.error,
    loading: live.loading,
    grain: data?.grain ?? grainParam,
    setGrain: (g: StatementGrain) => setGrain(g),
    costs: costs.data,
    costsError: costs.error,
    changed,
    /** Adding, changing and removing costs: "Manage costs" (owners, admins and whoever they gave it to), signed in to the account. */
    canManage: allowed("finance.costs") && !me.shared,
    /** Downloading the statement and the costs: "Export reports". */
    canExport: allowed("reports.export"),
  };
}

export type StatementState = ReturnType<typeof useStatement>;

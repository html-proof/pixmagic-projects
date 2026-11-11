import { weekStart } from "@app/shared/dates";

/**
 * The simple Home at a glance (lib/features.ts HOME_AT_A_GLANCE, components/dashboard/HomeGlance.tsx):
 * the dates most asked for as one-click chips, the quieter numbers under the four tiles, "Needs you"
 * kept to three until asked for more, and sales, expenses and profit by day, week or month. The
 * rules are here, apart from the drawing, so they can be tested.
 */

/** The dates one click away, in the order they are drawn; every other range stays in the dates menu. */
export const HOME_DATE_CHIPS = ["today", "yesterday", "wtd", "mtd", "30d", "lastmonth", "ytd"] as const;

// ---- Needs you ----------------------------------------------------------------------------------

/** How many of "Needs you" show before "Show n more". They arrive worst first, so the urgent ones are never the hidden ones. */
export const NEEDS_SHOWN = 3;

export function needsSplit<T>(needs: readonly T[], all: boolean, cap = NEEDS_SHOWN): { shown: T[]; more: number } {
  if (all || needs.length <= cap) return { shown: [...needs], more: 0 };
  return { shown: needs.slice(0, cap), more: needs.length - cap };
}

// ---- The quieter numbers --------------------------------------------------------------------------

export type SmallNumber = "netSales" | "costs" | "averageOrder" | "itemsSold";

/**
 * The numbers under the four tiles: each headline figure the tiles don't already show, so nothing
 * is said twice. The tiles (app/(app)/dashboard/page.tsx) are Total sales (Net sales for a member
 * who isn't shown the total), Orders, then net profit or what is left over when a cost was taken
 * off (else Average order value), then Visits that bought when visits are tracked (else Average
 * order value, else Total products sold).
 */
export function smallNumbers(tiles: { totalSales: boolean; leftOver: boolean; funnel: boolean; costs: boolean }): SmallNumber[] {
  const averageOrderIsTile = !tiles.leftOver || !tiles.funnel;
  const itemsSoldIsTile = !tiles.leftOver && !tiles.funnel;
  return [
    ...(tiles.totalSales ? (["netSales"] as const) : []),
    ...(tiles.leftOver && tiles.costs ? (["costs"] as const) : []),
    ...(averageOrderIsTile ? [] : (["averageOrder"] as const)),
    ...(itemsSoldIsTile ? [] : (["itemsSold"] as const)),
  ];
}

// ---- Sales, expenses and profit -------------------------------------------------------------------

export type GlanceView = "daily" | "weekly" | "monthly";
export const GLANCE_VIEWS: ReadonlyArray<{ id: GlanceView; label: string }> = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
];

/** A day, week or month of the profit and loss (@app/shared/profit ProfitLoss): each figure null when it can't be given. */
export interface MoneyPoint {
  from: string;
  to: string;
  revenue: number | null;
  totalExpenses: number | null;
  netProfit: number | null;
}

/** A sum in cents, so 0.1 + 0.2 is 0.3; null as soon as one part isn't known (never a part-sum passed off as the whole). */
const total = (xs: Array<number | null>): number | null => (xs.some((x) => x === null) ? null : xs.reduce<number>((a, x) => a + Math.round(x! * 100), 0) / 100);

/**
 * The days by calendar week (Monday to Sunday, as everywhere in the app). A week the days only
 * partly cover, the month's first or last, is the days it has.
 */
export function weeksOf(days: readonly MoneyPoint[]): MoneyPoint[] {
  const weeks: MoneyPoint[][] = [];
  let current: string | null = null;
  for (const d of days) {
    const w = weekStart(d.from);
    if (w !== current) {
      weeks.push([]);
      current = w;
    }
    weeks[weeks.length - 1]!.push(d);
  }
  return weeks.map((w) => ({
    from: w[0]!.from,
    to: w[w.length - 1]!.to,
    revenue: total(w.map((d) => d.revenue)),
    totalExpenses: total(w.map((d) => d.totalExpenses)),
    netProfit: total(w.map((d) => d.netProfit)),
  }));
}

/**
 * The view a visit opens on: the last 12 months, unless none of them can be drawn while this month's
 * days can (a store whose earlier sales aren't imported yet has only the days).
 */
export const firstView = (months: readonly MoneyPoint[], days: readonly MoneyPoint[]): GlanceView => (!drawable(months) && drawable(days) ? "daily" : "monthly");

/** Something to draw: at least one period's sales are known. */
export const drawable = (points: readonly MoneyPoint[]): boolean => points.some((p) => p.revenue !== null);

/** Every period drawn has its expenses and profit: nothing to explain under the chart. */
export const costsKnown = (points: readonly MoneyPoint[]): boolean => points.every((p) => p.revenue === null || p.netProfit !== null);

"use client";
import type { ReactNode } from "react";
import type { ProfitLoss } from "@app/shared/profit";
import { LineChart } from "@/components/dashboard/LineChart";
import { fmtMoneyCompact, fmtMonth } from "@/components/dashboard/format";
import { fmtMoney, fmtPct } from "@/lib/api";
import type { ProfitAnswer } from "./useProfit";

// ---------------------------------------------------------------------------
// Profit analysis: the month's days and the 12 months ending with it, drawn from the same figures
// as the panels above. A day or month whose profit can't be given has no column or point (never a
// 0); a loss is drawn below the line in red.
// ---------------------------------------------------------------------------

/** Each month's words under the axis and in the tooltip; this month "so far". */
export function monthPeriods(trend: ReadonlyArray<{ month: string }>, today: string) {
  return trend.map((m) => ({ tick: fmtMonth(m.month, { short: true }), long: `${fmtMonth(m.month, { year: true })}${m.month === today.slice(0, 7) ? " so far" : ""}` }));
}

const sum = (...xs: Array<number | null>) => (xs.some((x) => x === null) ? null : xs.reduce<number>((a, x) => a + Math.round(x! * 100), 0) / 100);
/** Everything spent: variable, fixed and below operating profit; null while the variable costs aren't known. */
const allCosts = (p: ProfitLoss) => sum(p.variableCosts, p.fixedCosts, p.belowOperating);

export function ProfitCharts({ data }: { data: ProfitAnswer }) {
  const money = (n: number) => fmtMoney(n, data.currency);
  const axis = (v: number) => fmtMoneyCompact(v, data.currency);
  const trend = data.trend;
  const months = trend.map((m) => `${m.month}-01`);
  const periods = monthPeriods(trend, data.today);
  const days = data.days.map((d) => d.from);
  const none = (values: Array<number | null>) => values.every((v) => v === null);
  const dailyProfit = data.days.map((d) => d.operatingProfit);
  const monthlyProfit = trend.map((m) => m.netProfit);

  return (
    <section className="card min-w-0 animate-rise" aria-labelledby="profit-charts-h" data-testid="profit-analysis">
      <h3 id="profit-charts-h" className="font-semibold">
        Profit analysis
      </h3>
      <p className="mt-0.5 text-xs text-muted">The days of {fmtMonth(data.month, { year: true })} and the 12 months to it. A day or month with missing data has no column.</p>
      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <Chart title="Daily profit or loss" help="Each day's operating profit: its sales less its variable costs and its share of the fixed costs." empty={none(dailyProfit)} testid="profit-chart-daily">
          <LineChart
            days={days}
            series={[{ key: "operating", label: "Operating profit", color: "var(--good)", negativeColor: "var(--danger)", values: dailyProfit }]}
            format={money}
            fmtAxis={axis}
            label="Operating profit day by day"
            today={data.today}
            bars
            height={200}
          />
        </Chart>
        <Chart title="Monthly profit or loss" help="Each month's net profit: every cost taken off, each once." empty={none(monthlyProfit)} testid="profit-chart-monthly">
          <LineChart
            days={months}
            periods={periods}
            series={[{ key: "net", label: "Net profit", color: "var(--good)", negativeColor: "var(--danger)", values: monthlyProfit }]}
            format={money}
            fmtAxis={axis}
            label="Net profit month by month"
            bars
            height={200}
          />
        </Chart>
        <Chart title="Sales vs expenses" help="Each month's sales (revenue) against everything it spent: variable, fixed, interest and tax." empty={none(trend.map((m) => m.revenue))} testid="profit-chart-sales-costs">
          <LineChart
            days={months}
            periods={periods}
            series={[
              { key: "sales", label: "Sales", color: "var(--viz-cat-1)", values: trend.map((m) => m.revenue) },
              { key: "costs", label: "Expenses", color: "var(--viz-cat-2)", values: trend.map(allCosts) },
            ]}
            format={money}
            fmtAxis={axis}
            label="Sales and expenses month by month"
            height={200}
          />
        </Chart>
        <Chart title="Fixed vs variable costs" help="Variable costs (products, ads, your variable costs) beside fixed costs, month by month." empty={none(trend.map((m) => m.fixedCosts || m.variableCosts))} testid="profit-chart-fixed-variable">
          <LineChart
            days={months}
            periods={periods}
            series={[
              { key: "variable", label: "Variable costs", color: "var(--warn)", values: trend.map((m) => m.variableCosts) },
              { key: "fixed", label: "Fixed costs", color: "var(--accent)", values: trend.map((m) => m.fixedCosts) },
            ]}
            format={money}
            fmtAxis={axis}
            label="Fixed and variable costs month by month"
            bars
            height={200}
          />
        </Chart>
        <Chart title="Profit margin trend" help="Gross, operating and net profit as a share of each month's sales." empty={none(trend.map((m) => m.grossMargin ?? m.operatingMargin))} testid="profit-chart-margins" wide>
          <LineChart
            days={months}
            periods={periods}
            series={[
              { key: "gross", label: "Gross margin", color: "var(--viz-cat-3)", values: trend.map((m) => m.grossMargin) },
              { key: "operating", label: "Operating margin", color: "var(--viz-cat-1)", values: trend.map((m) => m.operatingMargin) },
              { key: "net", label: "Net margin", color: "var(--viz-running)", values: trend.map((m) => m.netMargin) },
            ]}
            format={(v) => fmtPct(v)}
            fmtAxis={(v) => fmtPct(v)}
            label="Profit margins month by month"
            height={200}
          />
        </Chart>
      </div>
    </section>
  );
}

function Chart({ title, help, empty, testid, wide, children }: { title: string; help: string; empty: boolean; testid: string; wide?: boolean; children: ReactNode }) {
  return (
    <figure className={`min-w-0 ${wide ? "lg:col-span-2" : ""}`} data-testid={testid}>
      <figcaption>
        <span className="text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{help}</span>
      </figcaption>
      <div className="mt-2">{empty ? <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted">Missing data: nothing to draw until these figures can be worked out.</p> : children}</div>
    </figure>
  );
}

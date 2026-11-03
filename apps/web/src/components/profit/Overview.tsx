"use client";
import type { ReactNode } from "react";
import { categoryLabel, EXPENSE_SECTION_LABEL } from "@app/shared/expenses";
import { outcomeOf, PROFIT_OUTCOME_LABEL, type ProfitLoss } from "@app/shared/profit";
import { BarRow, StackedBar } from "@/components/dashboard/Charts";
import { LineChart } from "@/components/dashboard/LineChart";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { fmtMoneyCompact } from "@/components/dashboard/format";
import { fmtMoney, fmtPct } from "@/lib/api";
import { PLATFORM_NAME, toneOf, TONE_TEXT } from "./profitUi";
import { periodLabel } from "./Statement";
import type { StatementAnswer } from "./useStatement";

// ---------------------------------------------------------------------------
// The top of the Profit & Loss page: the figures that say whether the store made money in the dates,
// each beside the dates it's compared with, then where the money went (docs/kpis.md "Profit and
// loss"). Every figure is the server's; "Missing data" with its reason wherever an input isn't known.
// ---------------------------------------------------------------------------

const MISSING = "Missing data";

/** The change from the comparison, coloured by whether it is good for profit (`cost`: a rise is bad). */
function Change({ now, before, cost = false, points = false }: { now: number | null; before: number | null; cost?: boolean; points?: boolean }) {
  if (now === null || before === null) return null;
  if (points) {
    const d = (now - before) * 100;
    if (Math.abs(d) < 0.05) return <span className="text-xs text-muted">no change</span>;
    const good = cost ? d < 0 : d > 0;
    return <span className={`text-xs ${good ? "text-good" : "text-danger"}`}>{`${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)} pts`}</span>;
  }
  if (before === 0) return null;
  const change = (now - before) / Math.abs(before);
  if (Math.abs(change) < 0.0005) return <span className="text-xs text-muted">no change</span>;
  const good = cost ? change < 0 : change > 0;
  return <span className={`text-xs ${good ? "text-good" : "text-danger"}`}>{`${change > 0 ? "▲" : "▼"} ${fmtPct(Math.abs(change))}`}</span>;
}

function Card({ label, value, note, before, change, tone, testid, badge }: { label: string; value: string | null; note?: ReactNode; before?: string | null; change?: ReactNode; tone?: Tone; testid: string; badge?: number | null }) {
  const outcome = badge === undefined ? null : outcomeOf(badge);
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface p-3.5" data-testid={testid}>
      <p className="truncate text-xs text-muted" title={label}>
        {label}
      </p>
      <p className={`mt-1 truncate text-xl font-semibold tabular-nums ${tone ? (TONE_TEXT[tone] ?? "") : ""}`} title={value ?? MISSING} data-testid={`${testid}-value`}>
        {value ?? <span className="text-sm font-medium text-warn">{MISSING}</span>}
      </p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {outcome && outcome !== "missing" && <Badge tone={outcome === "profit" ? "good" : outcome === "loss" ? "danger" : "neutral"}>{PROFIT_OUTCOME_LABEL[outcome]}</Badge>}
        {change}
        {before !== undefined && <span className="text-xs text-muted">vs {before ?? "—"}</span>}
      </p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </div>
  );
}

export function OverviewCards({ a }: { a: StatementAnswer }) {
  const t = a.total;
  const c = a.compare;
  const money = (n: number | null) => (n === null ? null : fmtMoney(n, a.currency));
  const pct = (n: number | null) => (n === null ? null : fmtPct(n));
  const times = (n: number | null) => (n === null ? null : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)}×`);
  const profitNote = t.netProfit === null && t.afterKnownCosts !== null ? `Left after the costs known: ${fmtMoney(t.afterKnownCosts, a.currency)}` : undefined;
  return (
    <section className="space-y-3" aria-label="Profit overview" data-testid="pl-overview">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Card label="Revenue (tax included)" value={money(t.totalSales)} before={money(c.totalSales)} change={<Change now={t.totalSales} before={c.totalSales} />} testid="pl-card-total-sales" />
        <Card label="Revenue before tax" value={money(t.revenue)} before={money(c.revenue)} change={<Change now={t.revenue} before={c.revenue} />} note={t.taxes !== null ? `Tax collected: ${fmtMoney(t.taxes, a.currency)}` : undefined} testid="pl-card-revenue" />
        <Card label="Total expenses" value={money(t.totalExpenses)} before={money(c.totalExpenses)} change={<Change now={t.totalExpenses} before={c.totalExpenses} cost />} testid="pl-card-expenses" />
        <Card label="Profit or loss" value={money(t.netProfit)} tone={toneOf(t.netProfit)} badge={t.netProfit} before={money(c.netProfit)} change={<Change now={t.netProfit} before={c.netProfit} />} note={profitNote} testid="pl-card-profit" />
        <Card label="Profit margin" value={pct(t.netMargin)} tone={toneOf(t.netMargin)} before={pct(c.netMargin)} change={<Change now={t.netMargin} before={c.netMargin} points />} note="Profit ÷ revenue before tax" testid="pl-card-margin" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Card label="Advertising" value={money(t.advertising)} before={money(c.advertising)} change={<Change now={t.advertising} before={c.advertising} cost />} testid="pl-card-advertising" />
        <Card label="Variable costs" value={money(t.variableExAds)} before={money(c.variableExAds)} change={<Change now={t.variableExAds} before={c.variableExAds} cost />} testid="pl-card-variable" />
        <Card label="Fixed costs" value={money(t.fixedCosts)} before={money(c.fixedCosts)} change={<Change now={t.fixedCosts} before={c.fixedCosts} cost />} testid="pl-card-fixed" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="MER" value={pct(t.mer)} before={pct(c.mer)} note="Advertising ÷ revenue (tax incl.)" testid="pl-card-mer" />
        <Card label="Sitewide ROAS" value={times(t.roas)} before={times(c.roas)} note="Revenue (tax incl.) ÷ advertising" testid="pl-card-roas" />
        <Card label="VCR" value={pct(t.vcr)} before={pct(c.vcr)} note="Variable costs ÷ revenue" testid="pl-card-vcr" />
        <Card label="FCR" value={pct(t.fcr)} before={pct(c.fcr)} note="Fixed costs ÷ revenue" testid="pl-card-fcr" />
      </div>
    </section>
  );
}

function Chart({ title, help, empty, testid, children }: { title: string; help: string; empty: boolean; testid: string; children: ReactNode }) {
  return (
    <figure className="min-w-0" data-testid={testid}>
      <figcaption>
        <span className="text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{help}</span>
      </figcaption>
      <div className="mt-2">{empty ? <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted">Missing data: nothing to draw until these figures can be worked out.</p> : children}</div>
    </figure>
  );
}

/** Each cost of the dates, biggest first: the synced ones (products, each ad platform) and the owner's by category. */
function costsRanked(a: StatementAnswer, t: ProfitLoss) {
  return [
    ...(t.productCosts !== null && !t.grossGaps.length && t.productCosts !== 0 ? [{ key: "products", label: "Product costs (Shopify)", sub: "Variable costs", amount: t.productCosts }] : []),
    ...Object.entries(t.adSpendBy)
      .filter(([, v]) => v !== null && v !== 0)
      .map(([p, v]) => ({ key: `ads-${p}`, label: `${PLATFORM_NAME[p] ?? p} ad spend`, sub: "Advertising (synced)", amount: v! })),
    ...t.yours.byCategory.map((c) => ({ key: c.category, label: categoryLabel(c.category, a.categories), sub: EXPENSE_SECTION_LABEL[c.section], amount: c.amount })),
  ].sort((x, y) => y.amount - x.amount);
}

export function OverviewCharts({ a }: { a: StatementAnswer }) {
  const t = a.total;
  const money = (n: number) => fmtMoney(n, a.currency);
  const axis = (v: number) => fmtMoneyCompact(v, a.currency);
  const cols = a.columns;
  const periods = a.grain === "day" ? undefined : cols.map((c) => ({ tick: periodLabel(c, a.grain), long: periodLabel(c, a.grain) }));
  const none = (values: Array<number | null>) => values.every((v) => v === null);
  const ranked = costsRanked(a, t);
  const top = Math.max(...ranked.map((r) => Math.abs(r.amount)), 0);
  const adRows = [
    ...Object.entries(t.adSpendBy).map(([p, v]) => ({ key: p, label: `${PLATFORM_NAME[p] ?? p} (synced)`, amount: v })),
    ...t.yours.byCategory.filter((c) => c.section === "advertising").map((c) => ({ key: c.category, label: categoryLabel(c.category, a.categories), amount: c.amount as number | null })),
  ];
  const adTop = Math.max(...adRows.map((r) => Math.abs(r.amount ?? 0)), 0);
  return (
    <section className="card min-w-0 animate-rise" aria-labelledby="pl-charts-h" data-testid="pl-charts">
      <h2 id="pl-charts-h" className="font-semibold">
        Where the money went
      </h2>
      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <Chart title="Revenue, expenses and profit" help={`Revenue before tax against every cost, ${a.grain === "day" ? "day" : a.grain} by ${a.grain === "day" ? "day" : a.grain}.`} empty={none(cols.map((c) => c.revenue))} testid="pl-chart-trend">
          <LineChart
            days={cols.map((c) => c.from)}
            periods={periods}
            series={[
              { key: "revenue", label: "Revenue", color: "var(--viz-cat-1)", values: cols.map((c) => c.revenue) },
              { key: "expenses", label: "Expenses", color: "var(--viz-cat-2)", values: cols.map((c) => c.totalExpenses) },
              { key: "profit", label: "Profit", color: "var(--good)", negativeColor: "var(--danger)", values: cols.map((c) => c.netProfit) },
            ]}
            format={money}
            fmtAxis={axis}
            label="Revenue, expenses and profit"
            today={a.today}
            bars
            height={220}
          />
        </Chart>
        <Chart title="Daily profit or loss" help="Each day's profit: its revenue less its costs and its share of the fixed costs." empty={none(a.daily.map((d) => d.netProfit))} testid="pl-chart-daily">
          <LineChart
            days={a.daily.map((d) => d.day)}
            series={[{ key: "profit", label: "Profit", color: "var(--good)", negativeColor: "var(--danger)", values: a.daily.map((d) => d.netProfit) }]}
            format={money}
            fmtAxis={axis}
            label="Profit day by day"
            today={a.today}
            bars
            height={220}
          />
        </Chart>
        <div className="min-w-0">
          <p className="text-sm font-medium">Expense breakdown</p>
          <p className="text-xs text-muted">Every cost of the dates, biggest first.</p>
          {ranked.length ? (
            <ul className="mt-3 space-y-3" data-testid="pl-cost-ranking">
              {ranked.slice(0, 10).map((r) => (
                <BarRow key={r.key} label={r.label} sub={r.sub} value={money(r.amount)} fraction={top > 0 ? Math.max(0, r.amount) / top : 0} />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted">No costs in these dates yet.</p>
          )}
        </div>
        <div className="min-w-0">
          <div data-testid="pl-ads-breakdown">
            <p className="text-sm font-medium">Advertising</p>
            <p className="text-xs text-muted">
              {a.setup.ads === "none" ? "No ad account connected: ads paid elsewhere are your own costs." : a.setup.ads === "hidden" ? "The ad spend isn't shown to you." : a.setup.ads === "unusable" ? "The connected accounts' spend isn't in the store's currency, so it isn't counted." : "The connected accounts' spend, then ads paid elsewhere."}
            </p>
            {adRows.length > 0 && (
              <ul className="mt-3 space-y-3">
                {adRows.map((r) => (
                  <BarRow key={r.key} label={r.label} value={r.amount === null ? MISSING : money(r.amount)} fraction={adTop > 0 && r.amount !== null ? Math.max(0, r.amount) / adTop : 0} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      <div className="mt-6 border-t border-border pt-4" data-testid="pl-fixed-variable">
        <p className="text-sm font-medium">Fixed vs variable</p>
        <p className="mb-3 text-xs text-muted">Each kind of cost&apos;s share of the dates&apos; expenses.</p>
        <StackedBar
          label="Costs by kind"
          format={money}
          segments={[
            { label: "Advertising", value: t.advertising ?? 0, fill: "bg-violet" },
            { label: "Variable costs", value: t.variableExAds ?? 0, fill: "bg-warn" },
            { label: "Fixed costs", value: t.fixedCosts, fill: "bg-accent" },
            ...(t.belowOperating ? [{ label: "Interest, tax", value: t.belowOperating, fill: "bg-rose" }] : []),
          ]}
        />
      </div>
    </section>
  );
}

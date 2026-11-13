"use client";
import { Fragment, type ReactNode } from "react";
import { ArrowRight, CalendarPlus, ChartColumn, CircleDollarSign, Download, Info, Megaphone, PieChart, ReceiptText, ShoppingCart, Sparkles, TrendingDown, TrendingUp, Trophy } from "lucide-react";
import { PROFIT_LOSS_GAP_WORDS, type ProfitLoss } from "@app/shared/profit";
import { Donut } from "@/components/dashboard/Charts";
import { LineChart } from "@/components/dashboard/LineChart";
import { fmtDay, fmtMoneyCompact, fmtSpan, fmtWeekday, plural } from "@/components/dashboard/format";
import { HelpTip } from "@/components/PageKit";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { IconTile, MISSING, PlCard } from "./PlKit";
import { costGroups, profitDays, toneOf, TONE_TEXT } from "./profitUi";
import { periodLabel } from "./Statement";
import type { StatementAnswer } from "./useStatement";

// ---------------------------------------------------------------------------
// The Overview tab of Profit & Loss (the owner's design, 13 Nov 2026): how revenue, expenses and
// profit moved over the dates, what stands out in plain words, where the money went, the best and
// worst days, and the statement. Every figure is the server's
// (docs/kpis.md "Profit and loss"); what can't be worked out says "Missing data" and why.
// ---------------------------------------------------------------------------

const GRAIN_WORD = { day: "day", week: "week", month: "month", year: "year" } as const;

/** "Tue 3 Nov". */
const dayWords = (day: string) => `${fmtWeekday(day)} ${fmtDay(day, { year: false })}`;

/** Why profit can't be given for the dates, in a sentence; null when it can. */
export const whyNoProfit = (t: ProfitLoss): string | null => (t.gaps.length ? PROFIT_LOSS_GAP_WORDS[t.gaps[0]!] : null);

export function TrendCard({ a, className = "" }: { a: StatementAnswer; className?: string }) {
  const cols = a.columns;
  const word = GRAIN_WORD[a.grain];
  const periods = a.grain === "day" ? undefined : cols.map((c) => ({ tick: periodLabel(c, a.grain), long: periodLabel(c, a.grain) }));
  const empty = cols.every((c) => c.revenue === null);
  const noProfit = !empty && cols.every((c) => c.netProfit === null);
  return (
    <PlCard id="pl-chart-trend" icon={<CircleDollarSign className="h-5 w-5" />} tone="var(--violet)" title="Revenue, Expenses & Profit Trend" sub={`How your business performed, ${word} by ${word}.`} className={className}>
      {empty ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-10 text-center text-sm text-muted">Missing data: nothing to draw until these dates&apos; sales are known.</p>
      ) : (
        <LineChart
          days={cols.map((c) => c.from)}
          periods={periods}
          series={[
            { key: "revenue", label: "Revenue (before tax)", color: "var(--viz-cat-1)", values: cols.map((c) => c.revenue) },
            { key: "expenses", label: "Expenses", color: "var(--viz-cat-2)", values: cols.map((c) => c.totalExpenses) },
            { key: "profit", label: "Profit", color: "var(--good)", negativeColor: "var(--danger)", values: cols.map((c) => c.netProfit), line: true },
          ]}
          format={(n) => fmtMoney(n, a.currency)}
          fmtAxis={(v) => fmtMoneyCompact(v, a.currency)}
          label="Revenue, expenses and profit"
          today={a.today}
          bars
          height={340}
        />
      )}
      {noProfit && <p className="mt-2 text-xs text-muted">The profit line appears once profit can be worked out: {whyNoProfit(a.total)}</p>}
    </PlCard>
  );
}

interface Insight {
  key: string;
  tone: string;
  icon: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
}

/** What stands out in the dates, each in a sentence a figure on the page backs: nothing is guessed. */
function insightsOf(a: StatementAnswer, events: number | null, addEvent: ReactNode): Insight[] {
  const t = a.total;
  const money = (n: number) => fmtMoney(n, a.currency);
  const out: Insight[] = [];

  if (t.netProfit === null) {
    out.push({ key: "profit", tone: "var(--warn)", icon: <Info className="h-4 w-4" />, title: "Profit can't be shown for these dates yet", sub: whyNoProfit(t) });
  } else {
    const loss = t.netProfit < 0;
    const amount = money(Math.abs(t.netProfit));
    out.push({
      key: "profit",
      tone: loss ? "var(--danger)" : "var(--good)",
      icon: loss ? <TrendingDown className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />,
      title: loss ? `You made a loss of ${amount}` : t.netProfit === 0 ? "You broke even" : `You made a profit of ${amount}`,
    });
  }

  const biggest = costGroups(t)
    .filter((g): g is typeof g & { amount: number } => g.amount !== null && g.amount > 0)
    .sort((x, y) => y.amount - x.amount)[0];
  if (biggest) {
    const share = t.totalExpenses && t.totalExpenses > 0 ? ` (≈ ${fmtPct(biggest.amount / t.totalExpenses)} of total expenses)` : "";
    out.push({ key: "largest", tone: "var(--rose)", icon: <ShoppingCart className="h-4 w-4" />, title: `${biggest.label} ${biggest.key === "advertising" ? "is" : "are"} your largest expense`, sub: `${money(biggest.amount)}${share}.` });
  } else {
    out.push({ key: "largest", tone: "var(--rose)", icon: <ShoppingCart className="h-4 w-4" />, title: "No expenses in these dates yet", sub: "Add your costs under Expenses so profit is complete." });
  }

  if (t.advertising === null) out.push({ key: "ads", tone: "var(--info)", icon: <Megaphone className="h-4 w-4" />, title: "Advertising spend isn't known for these dates", sub: "The Expenses tab says why." });
  else if (t.advertising === 0) out.push({ key: "ads", tone: "var(--info)", icon: <Megaphone className="h-4 w-4" />, title: "No advertising spend in this period." });
  else out.push({ key: "ads", tone: "var(--info)", icon: <Megaphone className="h-4 w-4" />, title: `You spent ${money(t.advertising)} on advertising`, sub: t.mer === null ? undefined : `${fmtPct(t.mer)} of your revenue (tax included).` });

  const days = profitDays(a.daily, t.netProfit);
  if (days.best && a.daily.length > 1 && days.best.netProfit > 0) out.push({ key: "best", tone: "var(--violet)", icon: <Trophy className="h-4 w-4" />, title: `Your best day was ${dayWords(days.best.day)}`, sub: `${money(days.best.netProfit)} of profit.` });

  if (events === 0) out.push({ key: "events", tone: "var(--info)", icon: <CalendarPlus className="h-4 w-4" />, title: "Add a few business events (e.g. sale, campaign)", sub: <>to see how they impact profit. {addEvent}</> });
  else if (events) out.push({ key: "events", tone: "var(--info)", icon: <CalendarPlus className="h-4 w-4" />, title: `${plural(events, "business event")} in these dates`, sub: "The Detailed Table sets their days against the others." });
  return out;
}

export function KeyInsights({ a, events, onAddEvent }: { a: StatementAnswer; /** Business events in the dates; null while not known. */ events: number | null; onAddEvent: (() => void) | null }) {
  const add = onAddEvent && (
    <button type="button" className="font-medium text-accent underline-offset-2 hover:underline" onClick={onAddEvent} data-print-hide>
      Add one
    </button>
  );
  const list = insightsOf(a, events, add);
  return (
    <PlCard id="pl-insights" icon={<Sparkles className="h-5 w-5" />} tone="var(--violet)" title="Key Insights">
      <ul className="space-y-2.5">
        {list.map((i) => (
          <li key={i.key} className="flex items-start gap-3 rounded-lg border border-home-line p-3" data-testid={`pl-insight-${i.key}`}>
            <IconTile tone={i.tone} size="sm">
              {i.icon}
            </IconTile>
            <div className="min-w-0 text-sm">
              <p className="font-semibold">{i.title}</p>
              {i.sub && <p className="mt-0.5 text-xs text-muted">{i.sub}</p>}
            </div>
          </li>
        ))}
      </ul>
    </PlCard>
  );
}

/** Where the money went: the five groups that add up to total expenses, as a ring and a list. */
export function ExpenseDonut({ a }: { a: StatementAnswer }) {
  const t = a.total;
  const money = (n: number) => fmtMoney(n, a.currency);
  const groups = costGroups(t);
  const known = groups.reduce((n, g) => n + Math.round((g.amount ?? 0) * 100), 0) / 100;
  const total = t.totalExpenses;
  const whole = total ?? known;
  const share = (n: number | null) => (n === null ? MISSING : whole > 0 ? fmtPct(n / whole) : "—");
  return (
    <PlCard
      id="pl-expense-breakdown"
      icon={<PieChart className="h-5 w-5" />}
      tone="var(--violet)"
      title="Expense Breakdown"
      sub={total === null ? `Where your money went: ${money(known)} of costs known so far.` : `Where your money went (${money(total)} total).`}
    >
      <div className="@container">
        <div className="flex flex-col items-center gap-6 @[28rem]:flex-row">
          <Donut slices={groups.map((g) => ({ key: g.key, label: g.label, value: g.amount ?? 0, color: g.color }))} label={`Expenses: ${groups.map((g) => `${g.label} ${g.amount === null ? MISSING : money(g.amount)}`).join(", ")}`} size={176} thickness={24}>
            <span className="text-lg font-bold tracking-tight tabular-nums">{whole > 0 || total !== null ? money(whole) : "—"}</span>
            <span className="text-[11px] leading-tight text-muted">{total === null ? "Costs known" : "Total Expenses"}</span>
          </Donut>
          <ul className="w-full min-w-0 flex-1 divide-y divide-home-line text-sm" data-testid="pl-cost-groups">
            {groups.map((g) => (
              <li key={g.key} className="flex items-center gap-2 py-2">
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: g.color }} />
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  <span className="truncate">{g.label}</span>
                  <HelpTip label={g.label}>{g.help}</HelpTip>
                </span>
                <span className="shrink-0 font-semibold tabular-nums">{g.amount === null ? <span className="text-xs font-medium text-warn">{MISSING}</span> : money(g.amount)}</span>
                <span className="w-14 shrink-0 text-right text-xs text-muted tabular-nums">{g.amount === null ? "" : share(g.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </PlCard>
  );
}

/** The dates' profit a day: its average, its best and worst day, and the whole. */
export function ProfitAnalysisCard({ a }: { a: StatementAnswer }) {
  const t = a.total;
  const money = (n: number) => fmtMoney(n, a.currency);
  const d = profitDays(a.daily, t.netProfit);
  const why = whyNoProfit(t);
  const row = (label: string, value: number | null, opts: { note?: string; strong?: boolean; plain?: boolean; testid: string }) => {
    const tone = opts.plain ? undefined : toneOf(value);
    return (
      <div className="flex items-baseline justify-between gap-3 border-b border-home-line py-3 last:border-b-0" data-testid={opts.testid}>
        <dt className="min-w-0 text-sm">
          {label}
          {opts.note && <span className="ml-2 text-xs text-muted">{opts.note}</span>}
        </dt>
        <dd className={`shrink-0 tabular-nums ${opts.strong ? "text-base font-bold" : "font-semibold"} ${tone ? (TONE_TEXT[tone] ?? "") : ""}`}>{value === null ? <span className="text-xs font-medium text-warn">{MISSING}</span> : money(value)}</dd>
      </div>
    );
  };
  return (
    <PlCard id="pl-profit-analysis" icon={<ChartColumn className="h-5 w-5" />} tone="var(--violet)" title="Profit Analysis" sub={`Each day's profit after its own costs and its share of the fixed costs, over ${plural(a.daily.length, "day")}.`}>
      <dl className="rounded-lg border border-home-line px-4">
        {row("Daily average profit", d.average, { plain: true, testid: "pl-analysis-average" })}
        {row("Highest profit day", d.best?.netProfit ?? null, { note: d.best ? dayWords(d.best.day) : undefined, testid: "pl-analysis-best" })}
        {row("Lowest profit day", d.worst?.netProfit ?? null, { note: d.worst ? dayWords(d.worst.day) : undefined, testid: "pl-analysis-worst" })}
        {row("Total profit (period)", t.netProfit, { strong: true, plain: true, testid: "pl-analysis-total" })}
      </dl>
      {why && <p className="mt-3 text-xs text-muted">{why}</p>}
    </PlCard>
  );
}

type Format = "money" | "count" | "percent";
interface Row {
  id: string;
  label: string;
  format: Format;
  value: (p: ProfitLoss) => number | null;
  /** The line the statement leads to. */
  highlight?: boolean;
  strong?: boolean;
}

const SECTIONS: Array<{ id: string; label: string; rows: Row[] }> = [
  {
    id: "revenue",
    label: "Revenue",
    rows: [
      { id: "total_sales", label: "Revenue (Tax Included)", format: "money", value: (p) => p.totalSales },
      { id: "revenue", label: "Revenue Before Tax", format: "money", value: (p) => p.revenue },
      { id: "taxes", label: "Tax Collected", format: "money", value: (p) => p.taxes },
    ],
  },
  {
    id: "sales",
    label: "Sales Stats",
    rows: [
      { id: "orders", label: "Orders", format: "count", value: (p) => p.orders },
      { id: "units", label: "Items Sold", format: "count", value: (p) => p.units },
    ],
  },
  {
    id: "expenses",
    label: "Expenses",
    rows: [
      { id: "advertising", label: "Advertising", format: "money", value: (p) => p.advertising },
      { id: "variable", label: "Variable Costs", format: "money", value: (p) => p.variableExAds },
      { id: "fixed", label: "Fixed Costs", format: "money", value: (p) => p.fixedCosts },
      { id: "below", label: "Interest, Tax and Other", format: "money", value: (p) => p.belowOperating },
    ],
  },
  {
    id: "profit",
    label: "Profit",
    rows: [
      { id: "total_expenses", label: "Total Expenses", format: "money", value: (p) => p.totalExpenses },
      { id: "profit", label: "Profit (After Tax)", format: "money", value: (p) => p.netProfit, highlight: true, strong: true },
      { id: "margin", label: "Profit Margin", format: "percent", value: (p) => p.netMargin, strong: true },
    ],
  },
];

const DASH = <span className="text-muted/60">—</span>;

/** The statement for the dates as a whole, a row per figure. The Detailed Table has it period by period. */
export function SummaryStatement({ a, onDownload, onDetails }: { a: StatementAnswer; onDownload: (() => void) | null; onDetails: () => void }) {
  const show = (n: number | null, f: Format) => (n === null || !Number.isFinite(n) ? DASH : f === "money" ? fmtMoney(n, a.currency) : f === "percent" ? fmtPct(n) : fmtNum(n));
  const cell = "px-4 py-2.5 text-right whitespace-nowrap tabular-nums";
  return (
    <PlCard
      id="pl-summary"
      flush
      icon={<ReceiptText className="h-5 w-5" />}
      tone="var(--violet)"
      title="Profit & Loss Statement"
      sub={fmtSpan(a.range.from, a.range.to, { year: true })}
      actions={
        <>
          {onDownload && (
            <button type="button" className="home-btn border border-home-line bg-surface" onClick={onDownload} data-testid="pl-summary-csv">
              <Download aria-hidden className="h-4 w-4" />
              Download CSV
            </button>
          )}
          <button type="button" className="btn-primary h-9 gap-1.5 px-3 text-[13px]" onClick={onDetails} data-testid="pl-view-details">
            View Details
            <ArrowRight aria-hidden className="h-4 w-4" />
          </button>
        </>
      }
    >
      <div className="overflow-x-auto border-t border-home-line" tabIndex={0} role="region" aria-label="Profit and loss statement">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-home-soft text-xs">
              <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                Metric
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                This Period
                <span className="block font-normal text-muted">{fmtSpan(a.range.from, a.range.to)}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {SECTIONS.map((sec) => (
              <Fragment key={sec.id}>
                <tr>
                  <th scope="rowgroup" colSpan={2} className="border-t border-home-line bg-home-soft/60 px-4 py-2 text-left text-sm font-semibold">
                    {sec.label}
                  </th>
                </tr>
                {sec.rows
                  // A line of 0 (no interest or tax recorded) says nothing.
                  .filter((r) => r.id !== "below" || r.value(a.total))
                  .map((r) => {
                    const now = r.value(a.total);
                    const profitTone = r.id === "profit" ? toneOf(now) : undefined;
                    return (
                      <tr key={r.id} className={`border-t border-home-line ${r.highlight ? "bg-good/10" : ""}`} data-testid={`pl-sum-${r.id}`}>
                        <th scope="row" className={`px-4 py-2.5 pl-6 text-left ${r.strong ? "font-semibold" : "font-normal"}`}>
                          {r.label}
                        </th>
                        <td className={`${cell} ${r.strong ? "font-semibold" : ""} ${profitTone ? (TONE_TEXT[profitTone] ?? "") : ""}`} data-testid="pl-sum-now">
                          {show(now, r.format)}
                        </td>
                      </tr>
                    );
                  })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-5 py-3 text-xs text-muted sm:px-6">
        In {a.currency}. A dash is a figure that can&apos;t be given (the Detailed Table says why).
      </p>
    </PlCard>
  );
}

export function OverviewTab({
  a,
  events,
  onAddEvent,
  onDownload,
  onDetails,
}: {
  a: StatementAnswer;
  events: number | null;
  onAddEvent: (() => void) | null;
  onDownload: (() => void) | null;
  onDetails: () => void;
}) {
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-3">
        <TrendCard a={a} className="xl:col-span-2" />
        <KeyInsights a={a} events={events} onAddEvent={onAddEvent} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ExpenseDonut a={a} />
        <ProfitAnalysisCard a={a} />
      </div>
      <SummaryStatement a={a} onDownload={onDownload} onDetails={onDetails} />
    </>
  );
}

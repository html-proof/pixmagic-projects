"use client";
import type { ReactNode } from "react";
import { Scale } from "lucide-react";
import { EXPENSE_CATEGORY_GROUP, EXPENSE_CATEGORY_LABEL, type ExpenseGroup } from "@app/shared/expenses";
import { outcomeOf, PROFIT_LOSS_GAP_WORDS, PROFIT_OUTCOME_LABEL, type ProfitLoss, type ProfitLossGap, type ProfitOutcome } from "@app/shared/profit";
import { weekdayOf } from "@app/shared/sales";
import { Skeleton } from "@/components/AppUi";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { fmtLongDay, fmtMonth, fmtSpan, fmtWeekday } from "@/components/dashboard/format";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { fmtMoney, fmtPct, friendlyError, isTransient } from "@/lib/api";
import { ProfitCharts } from "./ProfitCharts";
import { CompleteControl, ExpenseBreakdown } from "./ProfitCosts";
import { useProfit, type ProfitAnswer, type ProfitState } from "./useProfit";

// ---------------------------------------------------------------------------
// The Profit sheet's profit and loss (docs/kpis.md "Profit and loss"): whether the store made money
// on a day and in a month, every step from sales to net profit, where the money went, and how it has
// gone month by month. The figures are the server's (GET …/profit, @app/shared/profit): this only
// lays them out, and says "Missing data" with the reason wherever an input isn't known.
// ---------------------------------------------------------------------------

export const OUTCOME_TONE: Record<ProfitOutcome, Tone> = { profit: "good", loss: "danger", break_even: "neutral", missing: "warn" };
const TONE_TEXT: Partial<Record<Tone, string>> = { good: "text-good", danger: "text-danger" };
const MISSING = "Missing data";

/** "operating profit of ₹4,333.33", "net loss of ₹666.67", "break-even", "missing data". */
function verdict(n: number | null, kind: "operating" | "net", currency: string): string {
  const o = outcomeOf(n);
  if (o === "profit") return `${kind} profit of ${fmtMoney(n, currency)}`;
  if (o === "loss") return `${kind} loss of ${fmtMoney(Math.abs(n!), currency)}`;
  return o === "break_even" ? "break-even" : "missing data";
}

export function ProfitPanel() {
  const p = useProfit();
  if (!p.sees) {
    return (
      <section className="card text-sm text-muted" data-testid="profit-no-access">
        <h2 className="font-semibold text-text">Profit and loss</h2>
        <p className="mt-1">Profit and loss is worked out from the sales breakdown (shipping and fees charged) and your costs. Ask an owner or admin for &ldquo;View gross sales, discounts, tax, shipping and total sales&rdquo; in Team &amp; Access.</p>
      </section>
    );
  }
  const { data } = p;
  if (!data || !p.day) {
    return (
      <section className="card" aria-labelledby="profit-h">
        <h2 id="profit-h" className="font-semibold">
          Profit and loss
        </h2>
        {p.error ? (
          <div className="mt-3">
            <LoadError what="your profit and loss" error={p.error} onRetry={() => window.dispatchEvent(new Event("insights:retry"))} busy={p.loading} />
          </div>
        ) : (
          <div className="mt-3">
            <p className="sr-only" role="status">
              Loading your profit and loss…
            </p>
            <Skeleton lines={5} />
          </div>
        )}
      </section>
    );
  }
  return <ProfitView p={p} data={data} day={p.day} />;
}

function ProfitView({ p, data, day }: { p: ProfitState; data: ProfitAnswer; day: ProfitLoss }) {
  const money = (n: number | null | undefined) => (n === null || n === undefined ? MISSING : fmtMoney(n, data.currency));
  const thisMonth = data.today.slice(0, 7);
  const monthLabel = fmtMonth(data.month, { year: true });
  const running = data.total.to < data.allocation.to;
  const dayLabel = day.from === data.today ? "Today so far" : fmtLongDay(day.from);
  const months = monthChoices(data.firstMonth, thisMonth, data.month);
  const gaps = [...new Set([...data.total.gaps, ...day.gaps])];

  return (
    <div className="space-y-4" data-testid="profit-panel">
      <section className="card animate-rise" aria-labelledby="profit-h">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h2 id="profit-h" className="flex items-center gap-2 text-lg font-semibold">
              <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-accent/12 text-accent">
                <Scale className="h-4 w-4" />
              </span>
              Profit and loss
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Each day after its own costs and its share of the month&apos;s fixed costs, each month after every cost. Worked out from your store&apos;s
              sales, each product&apos;s cost per item in Shopify, your ad accounts&apos; spend and your own costs, in {data.currency}: nothing is estimated.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2" data-print-hide>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Month
              <select className="input h-9 w-auto py-0 text-sm" value={data.month} onChange={(e) => p.setMonth(e.target.value)} data-testid="profit-month">
                {months.map((m) => (
                  <option key={m} value={m}>
                    {fmtMonth(m, { year: true })}
                    {m === thisMonth ? " (this month)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Day
              <select className="input h-9 w-auto py-0 text-sm" value={day.from} onChange={(e) => p.setDay(e.target.value)} data-testid="profit-day">
                {[...data.days].reverse().map((d) => (
                  <option key={d.from} value={d.from}>
                    {fmtWeekday(d.from)} {Number(d.from.slice(8))}
                    {d.from === data.today ? " (today)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2" data-testid="profit-verdict">
          <Badge tone={OUTCOME_TONE[outcomeOf(day.operatingProfit)]}>
            {dayLabel}: {verdict(day.operatingProfit, "operating", data.currency)}
          </Badge>
          <Badge tone={OUTCOME_TONE[outcomeOf(data.total.netProfit)]}>
            {monthLabel}
            {running ? " so far" : ""}: {verdict(data.total.netProfit, "net", data.currency)}
          </Badge>
        </div>
        {p.older && p.error && (
          <div className="mt-3">
            <Alert kind={isTransient(p.error) ? "info" : "error"}>Couldn&apos;t load that month, so the figures below are still for {monthLabel}. {friendlyError(p.error)}</Alert>
          </div>
        )}
        {gaps.length > 0 && <MissingData p={p} data={data} gaps={gaps} />}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card min-w-0 animate-rise" aria-labelledby="profit-day-h" data-testid="profit-daily">
          <h3 id="profit-day-h" className="font-semibold">
            Daily performance
          </h3>
          <p className="mt-0.5 text-xs text-muted">{day.from === data.today ? `${fmtLongDay(day.from)}, so far today` : fmtLongDay(day.from)}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
            <Tile label="Sales" value={money(day.revenue)} note="Net sales + shipping and fees charged" testid="profit-day-sales" />
            <Tile label="Variable costs" value={money(day.variableCosts)} note="Products, ads and your variable costs" testid="profit-day-variable" />
            <Tile label="Allocated fixed costs" value={money(day.fixedCosts)} note={`Its share of ${fmtMonth(data.month)}'s fixed costs`} testid="profit-day-fixed" />
            <Tile label="Gross profit" value={money(day.grossProfit)} tone={toneOf(day.grossProfit)} note="Net sales − product costs" testid="profit-day-gross" />
            <Tile label="Operating profit" value={money(day.operatingProfit)} tone={toneOf(day.operatingProfit)} badge={day.operatingProfit} note="Sales − variable − fixed costs" testid="profit-day-operating" />
            <Tile label="Operating margin" value={day.operatingMargin === null ? (day.operatingProfit === null ? null : "—") : fmtPct(day.operatingMargin)} note="Operating profit ÷ sales" testid="profit-day-margin" />
          </div>
          <p className="mt-2 text-xs text-muted" data-testid="profit-cash-flow">
            <b className="font-medium text-text">Cash flow: Not connected.</b> Cash flow is the money in and out of your bank account (payouts, bills paid, stock
            bought), which bizinsights doesn&apos;t read. It isn&apos;t the profit above.
          </p>
          <Breakdown pl={day} data={data} fixedNote={dayFixedNote(day, data, money)} testid="profit-day-breakdown" />
        </section>

        <section className="card min-w-0 animate-rise" aria-labelledby="profit-month-h" data-testid="profit-monthly">
          <h3 id="profit-month-h" className="font-semibold">
            Monthly performance
          </h3>
          <p className="mt-0.5 text-xs text-muted">
            {fmtSpan(data.total.from, data.total.to, { year: true })}
            {running ? ", so far this month" : ""}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
            <Tile label="Total sales" value={money(data.total.revenue)} testid="profit-month-sales" />
            <Tile label="Variable costs" value={money(data.total.variableCosts)} testid="profit-month-variable" />
            <Tile label="Fixed costs" value={money(data.total.fixedCosts)} testid="profit-month-fixed" />
            <Tile label="Gross profit" value={money(data.total.grossProfit)} tone={toneOf(data.total.grossProfit)} testid="profit-month-gross" />
            <Tile label="Operating profit" value={money(data.total.operatingProfit)} tone={toneOf(data.total.operatingProfit)} badge={data.total.operatingProfit} testid="profit-month-operating" />
            <Tile label="Below operating" value={money(data.total.belowOperating)} note="Interest, tax, depreciation" testid="profit-month-below" />
            <Tile label="Net profit" value={money(data.total.netProfit)} tone={toneOf(data.total.netProfit)} badge={data.total.netProfit} testid="profit-month-net" />
            <Tile label="Net margin" value={data.total.netMargin === null ? (data.total.netProfit === null ? null : "—") : fmtPct(data.total.netMargin)} note="Net profit ÷ sales" testid="profit-month-margin" />
          </div>
          <Breakdown pl={data.total} data={data} fixedNote={monthFixedNote(data, money)} testid="profit-month-breakdown" />
        </section>
      </div>

      <ExpenseBreakdown p={p} data={data} day={day} />
      <ProfitCharts data={data} />
    </div>
  );
}

/** The months offered: the store's first (or two years back, while unknown) to this one, newest first. */
function monthChoices(first: string | null, thisMonth: string, shown: string): string[] {
  const out: string[] = [];
  const start = first && first <= thisMonth ? first : `${Number(thisMonth.slice(0, 4)) - 2}${thisMonth.slice(4)}`;
  for (let m = thisMonth; m >= start && out.length < 600; ) {
    out.push(m);
    const y = Number(m.slice(0, 4));
    const mo = Number(m.slice(5, 7));
    m = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
  }
  if (!out.includes(shown)) out.push(shown);
  return out;
}

const toneOf = (n: number | null): Tone | undefined => {
  const o = outcomeOf(n);
  return o === "profit" ? "good" : o === "loss" ? "danger" : undefined;
};

/** One figure: "Missing data" when it can't be given; a profit in green, a loss in red, with its word. */
function Tile({ label, value, note, tone, badge, testid }: { label: string; value: string | null; note?: ReactNode; tone?: Tone; badge?: number | null; testid?: string }) {
  const shown = value === MISSING ? null : value;
  const outcome = badge === undefined ? null : outcomeOf(badge);
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-3" data-testid={testid}>
      <p className="truncate text-xs text-muted" title={label}>
        {label}
      </p>
      <p className={`mt-1 truncate text-lg font-semibold tabular-nums ${tone ? (TONE_TEXT[tone] ?? "") : ""}`} title={shown ?? MISSING} data-testid={testid && `${testid}-value`}>
        {shown ?? <span className="text-sm font-medium text-warn">{MISSING}</span>}
      </p>
      {outcome && outcome !== "missing" && (
        <p className="mt-0.5">
          <Badge tone={OUTCOME_TONE[outcome]}>{PROFIT_OUTCOME_LABEL[outcome]}</Badge>
        </p>
      )}
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </div>
  );
}

/** "₹50,000.00 of fixed costs in November ÷ 30 days = ₹1,666.67", or why the day's share differs. */
function dayFixedNote(d: ProfitLoss, data: ProfitAnswer, money: (n: number) => string): string {
  const a = data.allocation;
  const open = data.setup.operatingWeekdays;
  if (a.fixedCosts === 0) return `No fixed costs in your list for ${fmtMonth(data.month)}.`;
  if (open.length && !open.includes(weekdayOf(d.from))) return "The store is closed on this weekday, so it carries none of the month's fixed costs.";
  const even = a.days > 0 ? a.fixedCosts / a.days : 0;
  const days = open.length ? `${a.days} days open` : `${a.days} days`;
  if (Math.abs(d.fixedCosts - even) <= 0.05) return `${money(a.fixedCosts)} of fixed costs in ${fmtMonth(data.month)} ÷ ${days} = ${money(d.fixedCosts)}.`;
  return `Each fixed cost running on this day ÷ its month's ${open.length ? "open days" : "days"} (${fmtMonth(data.month)} in full: ${money(a.fixedCosts)} over ${days}).`;
}

function monthFixedNote(data: ProfitAnswer, money: (n: number) => string): string {
  const a = data.allocation;
  const spread = data.setup.operatingWeekdays.length ? `the ${a.days} days the store is open` : `its ${a.calendarDays} days`;
  if (data.total.to < a.to) return `The days so far, each its share: ${fmtMonth(data.month)} in full is ${money(a.fixedCosts)}, spread over ${spread}.`;
  return `Every fixed cost of ${fmtMonth(data.month)} once, spread over ${spread}.`;
}

/** The categories of one group of the owner's costs in these days, biggest first: "Packaging ₹100.00 · Payment fees ₹300.00". */
function categoriesNote(pl: ProfitLoss, group: ExpenseGroup, money: (n: number) => string): string | undefined {
  const list = pl.yours.byCategory.filter((c) => EXPENSE_CATEGORY_GROUP[c.category] === group);
  return list.length ? list.map((c) => `${EXPENSE_CATEGORY_LABEL[c.category]} ${money(c.amount)}`).join(" · ") : undefined;
}

/** Every step from sales to net profit, with the figure each step uses and where it comes from. */
function Breakdown({ pl, data, fixedNote, testid }: { pl: ProfitLoss; data: ProfitAnswer; fixedNote: string; testid: string }) {
  const money = (n: number) => fmtMoney(n, data.currency);
  const { setup } = data;
  const product: [string | null, string | undefined] =
    setup.productCosts === "hidden"
      ? ["Not shown to you", undefined]
      : setup.productCosts === "unavailable"
        ? ["Not shared", "The store doesn't share its products' costs with bizinsights."]
        : pl.productCosts === null
          ? [null, undefined]
          : [money(pl.productCosts), pl.uncostedSales ? `${money(pl.uncostedSales)} of sales have no cost per item in Shopify, so this is short.` : "The items sold at each product's cost per item in Shopify."];
  const ads: [string | null, string | undefined] =
    setup.ads === "none"
      ? [money(0), "No ad account connected: ads paid elsewhere go in your costs."]
      : setup.ads === "hidden"
        ? ["Not shown to you", undefined]
        : setup.ads === "unusable"
          ? ["Not usable", setup.adsDemo ? "The Google Ads demo's spend is simulated." : `Your ad accounts report in ${setup.adsCurrency ?? "another currency"}, not ${data.currency}.`]
          : pl.adSpend === null
            ? [null, "An ad account has no figures for some of these days yet."]
            : [money(pl.adSpend), "What the connected ad accounts spent."];
  const left = pl.revenue !== null && pl.variableCosts !== null ? (Math.round(pl.revenue * 100) - Math.round(pl.variableCosts * 100)) / 100 : null;
  const v = (n: number | null | undefined) => (n === null || n === undefined ? null : money(n));
  return (
    <details className="mt-3" open data-testid={testid}>
      <summary className="cursor-pointer text-sm font-medium text-accent">How this is worked out</summary>
      <table className="mt-2 w-full text-sm">
        <tbody>
          <Step label="Gross sales" value={v(pl.grossSales)} note="Items at full price, before discounts" />
          <Step sign="−" label="Discounts" value={v(pl.discounts)} />
          {pl.returns !== undefined && <Step sign="−" label="Returns and refunds" value={v(pl.returns)} />}
          <Step sign="=" label="Net sales" value={v(pl.netSales)} strong />
          <Step sign="+" label="Shipping and fees charged" value={v(pl.shippingAndFees)} note="Before tax: tax and duties are collected for governments" />
          <Step sign="=" label="Sales (revenue)" value={v(pl.revenue)} strong />
          <Step sign="−" label="Product costs" value={product[0]} note={product[1]} />
          <Step sign="−" label="Ad spend" value={ads[0]} note={ads[1]} />
          <Step sign="−" label="Your variable costs" value={money(pl.yours.byGroup.variable)} note={categoriesNote(pl, "variable", money)} />
          <Step sign="=" label="Left after variable costs" value={v(left)} strong />
          <Step sign="−" label="Fixed costs (allocated)" value={money(pl.fixedCosts)} note={categoriesNote(pl, "fixed", money) ? `${fixedNote} ${categoriesNote(pl, "fixed", money)}` : fixedNote} />
          <Step sign="=" label="Operating profit" value={v(pl.operatingProfit)} strong signed={pl.operatingProfit} />
          <Step sign="−" label="Interest, tax, depreciation" value={money(pl.belowOperating)} note={categoriesNote(pl, "non_operating", money)} />
          <Step sign="=" label="Net profit" value={v(pl.netProfit)} strong signed={pl.netProfit} />
        </tbody>
      </table>
      {pl.gaps.length > 0 && (
        <div className="mt-2 rounded-lg bg-warn/8 px-3 py-2 text-xs text-muted" data-testid={`${testid}-gaps`}>
          {pl.afterKnownCosts !== null && (
            <p className="text-text">
              Left after the costs bizinsights knows: <b className="tabular-nums">{money(pl.afterKnownCosts)}</b>. Not profit, because:
            </p>
          )}
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {pl.gaps.map((g) => (
              <li key={g}>{PROFIT_LOSS_GAP_WORDS[g]}</li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}

function Step({ sign, label, value, note, strong, signed }: { sign?: "−" | "+" | "="; label: string; value: string | null; note?: string; strong?: boolean; signed?: number | null }) {
  const tone = signed === undefined ? undefined : toneOf(signed);
  return (
    <tr className={strong ? "border-t border-border" : ""}>
      <th scope="row" className={`py-1 pr-3 text-left align-top ${strong ? "font-semibold" : "font-normal"}`}>
        <span aria-hidden className="inline-block w-4 text-muted">
          {sign}
        </span>
        {label}
        {note && <span className="block pl-4 text-xs font-normal text-muted">{note}</span>}
      </th>
      <td className={`whitespace-nowrap py-1 text-right align-top tabular-nums ${strong ? "font-semibold" : ""} ${tone ? (TONE_TEXT[tone] ?? "") : ""}`}>
        {value ?? <span className="text-xs font-medium text-warn">{MISSING}</span>}
      </td>
    </tr>
  );
}

/** What keeps a figure from being given, in a line each, with what fixes it where it can be fixed here. */
function MissingData({ p, data, gaps }: { p: ProfitState; data: ProfitAnswer; gaps: ProfitLossGap[] }) {
  const products = gaps.some((g) => g === "no_cost_recorded" || g === "uncosted_sales");
  return (
    <div className="mt-3 rounded-lg border border-warn/30 bg-warn/8 p-3 text-sm" data-testid="profit-missing">
      <p className="font-medium">Some figures show &ldquo;Missing data&rdquo;:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
        {gaps.map((g) => (
          <li key={g}>{PROFIT_LOSS_GAP_WORDS[g]}</li>
        ))}
      </ul>
      {data.setup.costsCount === 0 && <p className="mt-2 text-muted">Start with your monthly fixed costs (rent, salaries, software, insurance…) under Expense breakdown below.</p>}
      {products && <p className="mt-2 text-muted">Add each product&apos;s cost per item in Shopify (Products → a product → Cost per item); bizinsights reads it with your products.</p>}
      {gaps.includes("costs_not_complete") &&
        (p.canManageCosts ? (
          <CompleteControl p={p} data={data} />
        ) : (
          <p className="mt-2 text-muted">An owner or admin marks the costs list complete once it holds every cost.</p>
        ))}
    </div>
  );
}

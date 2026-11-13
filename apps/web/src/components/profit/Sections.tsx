"use client";
import { useState } from "react";
import { CalendarRange, ChartColumn, ChartLine, FolderCog, Scale, Sigma, Wallet } from "lucide-react";
import { categoryLabel, EXPENSE_SECTION_LABEL } from "@app/shared/expenses";
import type { ProfitLoss } from "@app/shared/profit";
import { useAction } from "@/components/AppUi";
import { BarRow } from "@/components/dashboard/Charts";
import { versusWords } from "@/components/dashboard/DateRange";
import { LineChart } from "@/components/dashboard/LineChart";
import { adsNotUsableWords } from "@/components/dashboard/profitFigures";
import { fmtMoneyCompact, fmtTimes, weekdayNames } from "@/components/dashboard/format";
import { api, fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { ExpenseDonut, ProfitAnalysisCard, whyNoProfit } from "./Overview";
import { Change, MiniTile, MISSING, PlCard, PointsChange, Steps } from "./PlKit";
import { PLATFORM_NAME } from "./profitUi";
import { periodLabel } from "./Statement";
import type { StatementAnswer, StatementState } from "./useStatement";

// ---------------------------------------------------------------------------
// The Revenue, Expenses and Profit Analysis tabs of Profit & Loss: each takes one part of the
// statement and says it in plain words, with the sum it comes from a step a line (docs/kpis.md
// "Profit and loss"). The figures are the server's; this only lays them out.
// ---------------------------------------------------------------------------

const GRAIN_WORD = { day: "day", week: "week", month: "month", year: "year" } as const;

const periodsOf = (a: StatementAnswer) => (a.grain === "day" ? undefined : a.columns.map((c) => ({ tick: periodLabel(c, a.grain), long: periodLabel(c, a.grain) })));

// ---- Revenue ---------------------------------------------------------------------------------------------

export function RevenueTab({ a, s }: { a: StatementAnswer; s: StatementState }) {
  const t = a.total;
  const c = a.compare;
  const money = (n: number | null | undefined) => (n === null || n === undefined ? null : fmtMoney(n, a.currency));
  const count = (n: number | null) => (n === null ? null : fmtNum(n));
  const versus = versusWords(s.shown);
  const word = GRAIN_WORD[a.grain];
  const empty = a.columns.every((x) => x.revenue === null);
  return (
    <>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-label="Revenue figures">
        <MiniTile label="Revenue (tax included)" value={money(t.totalSales)} change={<Change now={t.totalSales} before={c.totalSales} />} versus={versus} help="Everything customers paid, tax and duties included: Shopify's total sales." testid="pl-rev-total" />
        <MiniTile label="Revenue before tax" value={money(t.revenue)} change={<Change now={t.revenue} before={c.revenue} />} versus={versus} help="What the business keeps from its sales before any cost: net sales plus the shipping and fees charged. Profit is worked out from this." testid="pl-rev-before-tax" />
        <MiniTile label="Tax collected" value={money(t.taxes)} change={<Change now={t.taxes} before={c.taxes} />} versus={versus} help="Sales tax and duties collected from customers. It is passed on to the government, so it is never the store's income." testid="pl-rev-tax" />
        <MiniTile label="Orders" value={count(t.orders)} change={<Change now={t.orders} before={c.orders} />} versus={versus} testid="pl-rev-orders" />
        <MiniTile label="Items sold" value={count(t.units)} change={<Change now={t.units} before={c.units} />} versus={versus} testid="pl-rev-units" />
      </section>
      <div className="grid gap-4 xl:grid-cols-3">
        <PlCard id="pl-chart-revenue" icon={<ChartColumn className="h-5 w-5" />} tone="var(--viz-cat-1)" title="Revenue Trend" sub={`Revenue before tax, ${word} by ${word}.`} className="xl:col-span-2">
          {empty ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-10 text-center text-sm text-muted">Missing data: nothing to draw until these dates&apos; sales are known.</p>
          ) : (
            <LineChart
              days={a.columns.map((x) => x.from)}
              periods={periodsOf(a)}
              series={[{ key: "revenue", label: "Revenue (before tax)", color: "var(--viz-cat-1)", values: a.columns.map((x) => x.revenue) }]}
              format={(n) => fmtMoney(n, a.currency)}
              fmtAxis={(v) => fmtMoneyCompact(v, a.currency)}
              label="Revenue before tax"
              today={a.today}
              bars
              height={260}
            />
          )}
        </PlCard>
        <PlCard id="pl-revenue-steps" icon={<Sigma className="h-5 w-5" />} tone="var(--good)" title="How Revenue Is Worked Out" sub="From the price of what was sold to what customers paid.">
          <Steps
            testid="pl-revenue-sum"
            steps={[
              { label: "Gross sales", value: money(t.grossSales), note: "Items at full price, before discounts" },
              { sign: "−", label: "Discounts", value: money(t.discounts) },
              ...(t.returns !== undefined ? [{ sign: "−" as const, label: "Returns and refunds", value: money(t.returns) }] : []),
              { sign: "=", label: "Net sales", value: money(t.netSales), strong: true },
              { sign: "+", label: "Shipping and fees charged", value: money(t.shippingAndFees) },
              { sign: "=", label: "Revenue before tax", value: money(t.revenue), strong: true, note: "What profit is worked out from" },
              { sign: "+", label: "Tax collected", value: money(t.taxes), note: "Passed on to the government" },
              { sign: "=", label: "Revenue (tax included)", value: money(t.totalSales), strong: true },
            ]}
          />
        </PlCard>
      </div>
    </>
  );
}

// ---- Expenses --------------------------------------------------------------------------------------------

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

/** Why the connected accounts' spend is or isn't counted, in a line. */
function adsWords(a: StatementAnswer): string {
  const { setup } = a;
  if (setup.ads === "none") return "No ad account connected: ads paid elsewhere are your own costs.";
  if (setup.ads === "hidden") return "The ad spend isn't shown to you.";
  if (setup.ads === "unusable") return adsNotUsableWords({ demo: setup.adsDemo, currency: setup.adsCurrency, leftOut: setup.adsLeftOut ?? [] }, a.currency);
  return "The connected accounts' spend, then ads paid elsewhere.";
}

/** The top of the Expenses tab: the kinds of cost, where the money went (the Overview's ring), and every cost biggest first. */
export function ExpensesSummary({ a, s, onCategories }: { a: StatementAnswer; s: StatementState; onCategories: () => void }) {
  const t = a.total;
  const c = a.compare;
  const money = (n: number) => fmtMoney(n, a.currency);
  const orNull = (n: number | null) => (n === null ? null : money(n));
  const versus = versusWords(s.shown);
  const ranked = costsRanked(a, t);
  const top = Math.max(...ranked.map((r) => Math.abs(r.amount)), 0);
  // A platform whose spend isn't known for every day has no bar: it is named under the list instead.
  const adsMissing = Object.entries(t.adSpendBy)
    .filter(([, v]) => v === null)
    .map(([p]) => PLATFORM_NAME[p] ?? p);
  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Expense figures">
        <MiniTile label="Total expenses" value={orNull(t.totalExpenses)} change={<Change now={t.totalExpenses} before={c.totalExpenses} cost />} versus={versus} help="Advertising + variable costs + fixed costs (+ interest, tax and the like): each counted once." testid="pl-card-total-expenses" />
        <MiniTile label="Advertising" value={orNull(t.advertising)} change={<Change now={t.advertising} before={c.advertising} cost />} versus={versus} help="Your connected ad accounts' spend, plus the advertising you added yourself." testid="pl-card-advertising" />
        <MiniTile label="Variable costs" value={orNull(t.variableExAds)} change={<Change now={t.variableExAds} before={c.variableExAds} cost />} versus={versus} help="Costs that rise and fall with sales: what the items sold cost you, shipping, packaging, payment fees." testid="pl-card-variable" />
        <MiniTile label="Fixed costs" value={money(t.fixedCosts)} change={<Change now={t.fixedCosts} before={c.fixedCosts} cost />} versus={versus} help="Costs you pay whatever you sell (rent, salaries, software). A monthly cost is spread over its month's days, so these dates carry only their share." testid="pl-card-fixed" />
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <ExpenseDonut a={a} />
        <PlCard
          id="pl-cost-ranking-card"
          icon={<Wallet className="h-5 w-5" />}
          tone="var(--rose)"
          title="Every Cost, Biggest First"
          sub="Synced costs and your own, by category."
          actions={
            <button type="button" className="home-btn border border-home-line bg-surface" onClick={onCategories} disabled={!s.costs} data-testid="pl-categories-open">
              <FolderCog aria-hidden className="h-4 w-4" />
              Categories
            </button>
          }
        >
          {ranked.length ? (
            <ul className="space-y-3" data-testid="pl-cost-ranking">
              {ranked.slice(0, 10).map((r) => (
                <BarRow key={r.key} label={r.label} sub={r.sub} value={money(r.amount)} fraction={top > 0 ? Math.max(0, r.amount) / top : 0} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No costs in these dates yet.</p>
          )}
          <p className="mt-4 border-t border-home-line pt-3 text-xs text-muted" data-testid="pl-ads-breakdown">
            <b className="font-medium text-text">Advertising.</b> {adsWords(a)}
            {adsMissing.length > 0 && (
              <>
                {" "}
                {adsMissing.join(" and ")} ad spend: <span className="font-medium text-warn">{MISSING}</span> (an account has no figures for some of these days yet).
              </>
            )}
          </p>
        </PlCard>
      </div>
    </>
  );
}

/** How fixed costs are spread: over every calendar day, or only the weekdays the store is open. */
export function OperatingDays({ a, s }: { a: StatementAnswer; s: StatementState }) {
  const saved = a.setup.operatingWeekdays;
  const [picked, setPicked] = useState<number[] | null>(null);
  const { busy, run } = useAction();
  const days = picked ?? saved;
  const names = weekdayNames("short");
  const longNames = weekdayNames("long");
  const every = days.length === 0;
  const dirty = picked !== null && picked.join() !== saved.join();

  async function save() {
    if (!s.base || !picked) return;
    const ok = await run("days", "save the days the store is open", async () => {
      await api(`${s.base}/expenses/settings`, { method: "PUT", body: { operatingWeekdays: picked } });
      return picked.length ? "Fixed costs are now spread over the days the store is open." : "Fixed costs are now spread over every day.";
    });
    if (ok) {
      setPicked(null);
      await s.changed();
    }
  }

  return (
    <PlCard
      id="pl-operating-days"
      icon={<CalendarRange className="h-5 w-5" />}
      tone="var(--info)"
      title="How Fixed Costs Are Spread"
      sub={every ? "Over every calendar day: a month's fixed costs ÷ its days (28, 29, 30 or 31, each month its own)." : "Over the days the store is open: a month's fixed costs ÷ its open days; a closed day carries none."}
    >
      {s.canManage ? (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Days the store is open" data-print-hide>
          <button type="button" aria-pressed={every} className={`h-8 rounded-lg border px-2.5 text-xs font-medium transition ${every ? "border-accent bg-accent/12 text-accent" : "border-border text-muted hover:text-text"}`} onClick={() => setPicked([])}>
            Every day
          </button>
          {names.map((n, d) => {
            const on = !every && days.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                aria-label={longNames[d]}
                className={`h-8 min-w-10 rounded-lg border px-2 text-xs font-medium transition ${on ? "border-accent bg-accent/12 text-accent" : "border-border text-muted hover:text-text"}`}
                onClick={() => {
                  const from = every ? [0, 1, 2, 3, 4, 5, 6] : days;
                  const next = from.includes(d) ? from.filter((x) => x !== d) : [...from, d].sort();
                  // None open isn't a choice; all seven is every day.
                  if (next.length) setPicked(next.length === 7 ? [] : next);
                }}
              >
                {n}
              </button>
            );
          })}
          <button type="button" className="btn-secondary ml-1 h-8 px-3 text-xs" disabled={!dirty || busy === "days"} onClick={save} data-testid="pl-operating-save">
            {busy === "days" ? "Saving…" : "Save"}
          </button>
        </div>
      ) : (
        !every && <p className="text-xs text-muted">Open: {days.map((d) => longNames[d]).join(", ")}.</p>
      )}
    </PlCard>
  );
}

// ---- Profit analysis -------------------------------------------------------------------------------------

export function AnalysisTab({ a, s }: { a: StatementAnswer; s: StatementState }) {
  const t = a.total;
  const c = a.compare;
  const money = (n: number | null) => (n === null ? null : fmtMoney(n, a.currency));
  const pct = (n: number | null) => (n === null ? null : fmtPct(n));
  const versus = versusWords(s.shown);
  const none = a.daily.every((d) => d.netProfit === null);
  const why = whyNoProfit(t);
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <ProfitAnalysisCard a={a} />
        <PlCard id="pl-profit-steps" icon={<Scale className="h-5 w-5" />} tone="var(--good)" title="How Profit Is Worked Out" sub="Revenue before tax, less every cost.">
          <Steps
            testid="pl-profit-sum"
            steps={[
              { label: "Revenue before tax", value: money(t.revenue), note: "Net sales + shipping and fees charged" },
              { sign: "−", label: "Advertising", value: money(t.advertising) },
              { sign: "−", label: "Variable costs", value: money(t.variableExAds), note: "Product costs and your other variable costs" },
              { sign: "−", label: "Fixed costs", value: money(t.fixedCosts), note: "These dates' share" },
              { sign: "=", label: "Operating profit", value: money(t.operatingProfit), strong: true, signed: t.operatingProfit },
              { sign: "−", label: "Interest, tax and other", value: money(t.belowOperating) },
              { sign: "=", label: "Profit (After Tax)", value: money(t.netProfit), strong: true, signed: t.netProfit },
            ]}
          />
          {why && (
            <div className="mt-3 rounded-lg border border-warn/30 bg-warn/8 p-3 text-xs text-muted" data-testid="pl-profit-gaps">
              {t.afterKnownCosts !== null && (
                <p className="text-sm text-text">
                  Left after the costs bizinsights knows: <b className="tabular-nums">{fmtMoney(t.afterKnownCosts, a.currency)}</b>. Not called profit, because:
                </p>
              )}
              <p className="mt-1">{why}</p>
            </div>
          )}
        </PlCard>
      </div>
      <PlCard id="pl-chart-daily" icon={<ChartLine className="h-5 w-5" />} tone="var(--good)" title="Daily Profit or Loss" sub="Each day's profit: its revenue less its costs and its share of the fixed costs. Green is a profit, red a loss.">
        {none ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-10 text-center text-sm text-muted">Missing data: nothing to draw until profit can be worked out.</p>
        ) : (
          <LineChart
            days={a.daily.map((d) => d.day)}
            series={[{ key: "profit", label: "Profit", color: "var(--good)", negativeColor: "var(--danger)", values: a.daily.map((d) => d.netProfit) }]}
            format={(n) => fmtMoney(n, a.currency)}
            fmtAxis={(v) => fmtMoneyCompact(v, a.currency)}
            label="Profit day by day"
            today={a.today}
            bars
            height={240}
          />
        )}
      </PlCard>
      <section aria-labelledby="pl-ratios-h">
        <h2 id="pl-ratios-h" className="home-h2 mb-3">
          Ratios, in Plain Words
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <MiniTile label="Profit margin" value={pct(t.netMargin)} signed={t.netMargin} change={<PointsChange now={t.netMargin} before={c.netMargin} />} versus={versus} note="Of every 100 of revenue before tax, this much is profit." testid="pl-ratio-margin" />
          <MiniTile label="MER" value={pct(t.mer)} change={<PointsChange now={t.mer} before={c.mer} cost />} versus={versus} note="Marketing expense ratio: advertising as a share of revenue (tax included). Lower is better." testid="pl-card-mer" />
          <MiniTile label="Sitewide ROAS" value={t.roas === null ? null : fmtTimes(t.roas)} note="Revenue (tax included) for every 1 spent on advertising. Higher is better." testid="pl-card-roas" />
          <MiniTile label="VCR" value={pct(t.vcr)} change={<PointsChange now={t.vcr} before={c.vcr} cost />} versus={versus} note="Variable cost ratio: variable costs as a share of revenue before tax." testid="pl-card-vcr" />
          <MiniTile label="FCR" value={pct(t.fcr)} change={<PointsChange now={t.fcr} before={c.fcr} cost />} versus={versus} note="Fixed cost ratio: fixed costs as a share of revenue before tax." testid="pl-card-fcr" />
        </div>
      </section>
      <p className="px-1 text-xs text-muted" data-testid="pl-cash-flow">
        <b className="font-medium text-text">Cash flow: Not connected.</b> Cash flow is the money in and out of your bank account (payouts, bills paid, stock bought), which bizinsights doesn&apos;t read. It isn&apos;t the profit above.
      </p>
    </>
  );
}

"use client";
import { useState, type ReactNode } from "react";
import { ChartColumn, type LucideIcon } from "lucide-react";
import { customSalesMonths, dailyBreakdown, NET_SALES_MONTHS, TOTAL_SALES_MONTHS, weekdayOf, yearFigures } from "@app/shared/sales";
import { customSales } from "@app/shared/salesCalculation";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { ComboChart, type ComboBar, type ComboGroup } from "./ComboChart";
import { fmtDay, fmtLongDay, fmtMonth, fmtMoneyCompact, fmtMoneyWhole, fmtSpan, fmtWeekday, plural } from "./format";
import { ChartChoice } from "./Primitives";
import { appliedCustom, asSalesDays, dayLinesOf, hasMonthLines, showsRefunds, showsTotalSales } from "./redacted";
import type { Overview, YearMonth, YearOf } from "./types";

// ---------------------------------------------------------------------------
// The overview's sales panels, in the owner's design: the dates picked day by day, and this year
// month by month beside the same months of the two years before. Each has its columns' total in
// large type, one line on what is in it, a key, and the running total drawn over the columns.
// ---------------------------------------------------------------------------

function Panel({ id, title, total, sub, aside, legend, i, testId, children }: { id: string; title: string; total: ReactNode; sub: ReactNode; aside?: ReactNode; legend: ReactNode; i: number; testId: string; children: ReactNode }) {
  return (
    <section className="card animate-rise min-w-0 rounded-2xl px-[18px] pb-3 pt-[18px]" style={{ ["--i" as string]: i }} aria-labelledby={id} data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="text-xs font-bold uppercase tracking-[0.04em] text-muted">{title}</h2>
          <p className="mt-0.5 text-[26px] font-extrabold leading-tight tracking-tight tabular-nums">{total}</p>
          <p className="mt-0.5 text-[11px] text-muted first-letter:uppercase">{sub}</p>
        </div>
        {aside}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3.5 gap-y-1 text-[11px] text-muted">{legend}</div>
      {children}
    </section>
  );
}

/** A colour in the key, beside the words that say what it is (never colour alone). */
function Key({ color, line, children }: { color: string; line?: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={line ? "inline-block h-[3px] w-4 rounded-sm" : "inline-block h-[11px] w-[11px] rounded-[3px]"} style={{ background: color }} />
      {children}
    </span>
  );
}

function TipTitle({ children }: { children: ReactNode }) {
  return <div className="mb-1 font-bold text-text">{children}</div>;
}

function TipRow({ color, line, children }: { color: string; line?: boolean; children: ReactNode }) {
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-text">
      <span aria-hidden className={line ? "inline-block h-[3px] w-3 shrink-0 rounded-sm" : "inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]"} style={{ background: color }} />
      <span className="tabular-nums">{children}</span>
    </div>
  );
}

/** Shown over an empty chart's gridlines: what's missing, and when it will fill in. */
function EmptyChart({ icon: IconCmp, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 pb-6">
      <div className="flex max-w-xs flex-col items-center rounded-xl bg-surface/90 px-4 py-3 text-center">
        <span aria-hidden className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-surface text-muted shadow-[var(--shadow)]">
          <IconCmp className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <p className="mt-2 text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-xs text-muted">{body}</p>
      </div>
    </div>
  );
}

/** A colour a little lighter: a period only partly there. */
const lighter = (color: string) => `color-mix(in oklab, ${color} 45%, var(--surface))`;
/** "20 Aug & 22 Aug". */
const listOf = (items: string[]) => new Intl.ListFormat(undefined, { style: "short", type: "conjunction" }).format(items);
/** "+12.3%" / "−4%": a change with its sign, so the colour is never all that says which way. */
const signed = (c: number) => `${c >= 0 ? "+" : "−"}${fmtPct(Math.abs(c))}`;
/** "16.2K": figures on columns too narrow for the currency. */
const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

type DayView = "sales" | "custom" | "net" | "orders" | "refunds";

/** The dates picked, day by day: columns graded against the store's own average day, and the running total. */
function DailyPanel({ ov, currency }: { ov: Overview; currency: string }) {
  const s = ov.modules.sales_overview!;
  // Until one is picked: Custom sales when the store shows it on the dashboard, else total sales.
  const [picked, setPicked] = useState<DayView | null>(null);
  const custom = appliedCustom(s);
  // Refunds and total sales per day only for someone who may see them (Team & Access).
  const refundsShown = showsRefunds(s.series);
  const totalShown = showsTotalSales(s.series);
  const wanted = picked ?? (custom ? "custom" : "sales");
  const view: DayView =
    (wanted === "refunds" && !refundsShown) || (wanted === "sales" && !totalShown) || (wanted === "custom" && !custom) ? (totalShown ? "sales" : "net") : wanted;
  const historyFrom = ov.data?.historyFrom ?? null;

  const days = asSalesDays(s.series);
  const b = dailyBreakdown(days, ov.today, historyFrom, (d) => {
    if (view === "sales") return d.totalSales;
    if (view === "orders") return d.orders;
    if (view === "refunds") return d.refunds;
    if (view === "custom" && custom) {
      const lines = dayLinesOf(d);
      return lines ? customSales(lines, custom.components) : 0;
    }
    return d.netSales;
  });
  const money = view !== "orders";
  const full = (n: number) => (money ? fmtMoney(n, currency) : fmtNum(n));
  const whole = (n: number) => (money ? fmtMoneyWhole(n, currency) : fmtNum(n));
  const name = { sales: "Total sales", custom: `Custom sales · ${custom?.name ?? ""}`, net: "Net sales", orders: "Orders", refunds: "Returns" }[view];
  // Ordinary, strong and best days, from the store's own average day, for sales only.
  const tiers = view === "orders" || view === "refunds" ? null : b.tiers;
  const plain = view === "refunds" ? "var(--fill-danger)" : "var(--viz-day)";
  const partial = view === "refunds" ? lighter(plain) : "var(--viz-day-partial)";
  type Day = (typeof b.days)[number];
  const fillOf = (d: Day) =>
    d.status === "today" ? partial : tiers && d.tier === 3 ? "var(--viz-day-best)" : tiers && d.tier === 2 ? "var(--viz-day-strong)" : plain;

  const n = b.days.length;
  const groups: ComboGroup[] = b.days.map((d) => {
    const missing = d.status === "not_imported";
    return {
      key: d.day,
      bars: [{ value: missing ? null : d.value, fill: fillOf(d), label: !missing && d.value !== 0 ? whole(d.value) : undefined, quiet: d.status === "today" }],
      running: d.cumulative,
      tick: {
        top: fmtDay(d.day, { year: false }),
        bottom: fmtWeekday(d.day),
        weekend: weekdayOf(d.day) >= 5,
        strong: d.status === "today",
        // Long ranges label Mondays, very long ones the first of each month.
        major: n <= 31 || (n <= 120 ? weekdayOf(d.day) === 0 : d.day.endsWith("-01")),
      },
      keepLabel: d.day === b.best?.day || d.status === "today",
    };
  });

  const complete = b.days.filter((d) => d.status === "complete");
  const hasToday = b.days.some((d) => d.status === "today");
  const hasMissing = b.days.some((d) => d.status === "not_imported");
  // Days with nothing in them say so: a store's quiet day is worth knowing (not so for returns).
  const quiet = view === "refunds" ? [] : complete.filter((d) => d.value === 0);
  const none = view === "orders" ? "no orders" : "no sales";
  const notes = [
    view === "custom" && custom ? `Custom sales · ${custom.name}, not Shopify's figure` : null,
    hasToday && complete.length ? `${fmtSpan(complete[0]!.day, complete.at(-1)!.day)} complete` : null,
    quiet.length && quiet.length <= 3 ? `${listOf(quiet.map((d) => fmtDay(d.day, { year: false })))} ${none}` : quiet.length ? `${quiet.length} days with ${none}` : null,
    hasToday ? `${fmtDay(ov.today, { year: false })} is today (partial)` : null,
    hasMissing ? `orders before ${fmtDay(historyFrom, { year: false })} weren't shared by Shopify` : null,
  ].filter(Boolean);
  const empty = b.days.every((d) => d.value === 0);
  // No orders at all says so whatever is measured: it is why there are no sales either, and new
  // orders are what fill the chart in.
  const noOrders = b.days.every((d) => d.orders === 0);

  const tip = (i: number) => {
    const d = b.days[i]!;
    const head = `${fmtDay(d.day, { year: false })} · ${fmtWeekday(d.day)}${d.status === "today" ? " (partial)" : ""}`;
    if (d.status === "not_imported") {
      return (
        <>
          <TipTitle>{head}</TipTitle>
          <div className="text-muted">Not imported: Shopify shared orders from {fmtDay(historyFrom)} on.</div>
        </>
      );
    }
    return (
      <>
        <TipTitle>{head}</TipTitle>
        <TipRow color={fillOf(d)}>Day: <b>{full(d.value)}</b></TipRow>
        <TipRow color="var(--viz-running)" line>Running: <b>{full(d.cumulative ?? 0)}</b></TipRow>
        {view !== "orders" && (
          <div className="mt-1 text-muted">
            {plural(d.orders, "order")}
            {view === "custom" ? ` · net sales ${fmtMoney(d.netSales, currency)}` : ""}
          </div>
        )}
      </>
    );
  };
  const describe = (i: number) => {
    const d = b.days[i]!;
    if (d.status === "not_imported") return `${fmtLongDay(d.day)}: not imported.`;
    return `${fmtLongDay(d.day)}${d.status === "today" ? ", today so far" : ""}: ${full(d.value)} ${name}. ${full(d.cumulative ?? 0)} so far in these dates.`;
  };

  return (
    <Panel
      id="trend-sales-h"
      testId="trend-sales"
      i={0}
      title={`${fmtSpan(ov.range.from, ov.range.to)} · daily`}
      total={full(b.total)}
      sub={notes.length ? notes.join(" · ") : `${name} per day, with the running total`}
      aside={
        <ChartChoice<DayView>
          label="Sales chart shows"
          value={view}
          onChange={setPicked}
          options={[
            ...(totalShown ? [["sales", "Total sales"] as [DayView, string]] : []),
            ...(custom ? [["custom", `Custom sales · ${custom.name}`] as [DayView, string]] : []),
            ["net", "Net sales"],
            ["orders", "Orders"],
            ...(refundsShown ? [["refunds", "Returns"] as [DayView, string]] : []),
          ]}
        />
      }
      legend={
        <>
          {tiers ? (
            <>
              {tiers.best !== null && <Key color="var(--viz-day-best)">≥ {whole(tiers.best)}</Key>}
              <Key color="var(--viz-day-strong)">≥ {whole(tiers.strong)}</Key>
              <Key color="var(--viz-day)">&lt; {whole(tiers.strong)}</Key>
            </>
          ) : (
            <Key color={plain}>{name} per day</Key>
          )}
          {hasToday && <Key color={partial}>Today (partial)</Key>}
          <Key color="var(--viz-running)" line>Cumulative</Key>
        </>
      }
    >
      <div className="relative">
        <ComboChart
          groups={groups}
          label={`${name} per day, ${fmtSpan(ov.range.from, ov.range.to)}, with the running total`}
          fmtAxis={(v) => (money ? fmtMoneyCompact(v, currency) : fmtNum(v))}
          fmtRunning={(v) => (money ? fmtMoneyCompact(v, currency) : compact(v))}
          tooltip={tip}
          describe={describe}
        />
        {empty &&
          (view === "refunds" ? (
            <EmptyChart icon={ChartColumn} title="No refunds in this period" body="Refunds show up here on the day they're issued." />
          ) : view === "orders" || noOrders ? (
            <EmptyChart
              icon={ChartColumn}
              title="No orders in this period"
              body="Try a longer date range. New orders show up here within a few minutes while this page is open. Test orders aren't counted, as in Shopify's reports."
            />
          ) : (
            <EmptyChart icon={ChartColumn} title="No sales in this period" body="Try a longer date range. Sales appear here as soon as your store receives orders." />
          ))}
      </div>
    </Panel>
  );
}

type MonthView = "sales" | "custom" | "net";

/** Each year by its distance back, so a year keeps its colour whichever others are shown. */
const YEAR_FILL = ["var(--viz-day)", "var(--viz-year-1)", "var(--viz-year-2)"] as const;

/** This year month by month, beside the same months of the two years before (whole months). */
function MonthlyComparison({ ov, year, currency }: { ov: Overview; year: NonNullable<NonNullable<Overview["modules"]["sales_overview"]>["year"]>; currency: string }) {
  const s = ov.modules.sales_overview!;
  const [picked, setPicked] = useState<MonthView | null>(null);
  const custom = appliedCustom(s);
  // Oldest first; a year with nothing imported isn't drawn at all.
  const years: YearOf[] = [...(year.past ?? []).slice(0, 2).reverse().filter((y) => y.months.some((m) => m.coverage !== "none")), year];
  // Total sales and Custom sales need every month's lines (Team & Access: as the breakdown).
  const lined = years.every((y) => y.months.every(hasMonthLines));
  const wanted = picked ?? (custom ? "custom" : "sales");
  const view: MonthView = !lined ? "net" : wanted === "custom" && !custom ? "sales" : wanted;
  const figuresOf = (months: YearMonth[]) => {
    if (months.every(hasMonthLines)) {
      if (view === "custom" && custom) return yearFigures(months, customSalesMonths(custom.components));
      if (view === "sales") return yearFigures(months, TOTAL_SALES_MONTHS);
    }
    return yearFigures(months, NET_SALES_MONTHS);
  };
  const figures = years.map((y) => figuresOf(y.months));
  const mine = figures.at(-1)!;
  const money = (n: number) => fmtMoney(n, currency);
  const name = { sales: "Total sales", custom: `Custom sales · ${custom?.name ?? ""}`, net: "Net sales" }[view];
  const fillOf = (y: YearOf, m: YearMonth | undefined) => {
    const color = YEAR_FILL[year.year - y.year] ?? YEAR_FILL[2];
    if (!(m?.current || m?.coverage === "partial")) return color;
    return y === year ? "var(--viz-day-partial)" : lighter(color);
  };

  const groups: ComboGroup[] = year.months.map((m, i) => ({
    key: m.month,
    bars: years.map((y, j): ComboBar => {
      const ym = y.months[i];
      const fig = figures[j]!.months[i];
      const none = !ym || !fig || ym.coverage === "none";
      const mineToo = y === year;
      return {
        value: none ? null : fig.value,
        fill: fillOf(y, ym),
        label: none || fig.value === 0 ? undefined : compact(fig.value),
        quiet: mineToo && m.current,
        note: mineToo && fig?.change != null ? { text: signed(fig.change), tone: fig.change >= 0 ? "good" : "danger" } : undefined,
        sub: String(y.year),
      };
    }),
    running: mine.months[i]?.cumulative ?? null,
    tick: { top: fmtMonth(m.month, { short: true }), strong: m.current, major: true },
  }));

  const current = year.months.at(-1);
  const earlier = years.slice(0, -1).map((y) => String(y.year));
  const historyFrom = ov.data?.historyFrom ?? null;
  const someMissing = years.some((y) => y.months.some((m) => m.coverage !== "full"));
  const sub = [
    view === "custom" && custom ? `Custom sales · ${custom.name}, not Shopify's figure` : null,
    earlier.length ? `${year.year} so far vs the same months of ${listOf(earlier)}` : `${year.year} so far, month by month; no earlier year imported to compare with`,
    `% = ${year.year}'s change on the month before${current?.comparedWith ? ` (${fmtMonth(current.month, { short: true })}: on the same days)` : ""}`,
    someMissing && historyFrom ? `orders before ${fmtDay(historyFrom)} weren't shared by Shopify` : null,
  ].filter(Boolean);

  const tip = (i: number) => {
    const m = year.months[i]!;
    return (
      <>
        <TipTitle>{fmtMonth(m.month)}{m.current ? ` · to ${fmtDay(m.to, { year: false })}` : ""}</TipTitle>
        {years.map((y, j) => {
          const ym = y.months[i];
          const fig = figures[j]!.months[i];
          const none = !ym || !fig || ym.coverage === "none";
          return (
            <TipRow key={y.year} color={fillOf(y, ym)}>
              {y.year}: {none ? <span className="text-muted">not imported</span> : <b>{money(fig.value)}</b>}
              {y === year && m.current ? " (so far)" : ym?.coverage === "partial" ? " (partly imported)" : ""}
              {y === year && fig?.change != null && (
                <span className={`ml-1.5 font-semibold ${fig.change >= 0 ? "text-good" : "text-danger"}`}>{signed(fig.change)}</span>
              )}
            </TipRow>
          );
        })}
        <TipRow color="var(--viz-running)" line>{year.year} running: <b>{money(mine.months[i]?.cumulative ?? 0)}</b></TipRow>
      </>
    );
  };
  const describe = (i: number) => {
    const m = year.months[i]!;
    const parts = years.map((y, j) => {
      const fig = figures[j]!.months[i];
      return `${y.year}${y === year && m.current ? " so far" : ""} ${!fig || y.months[i]?.coverage === "none" ? "not imported" : money(fig.value)}`;
    });
    const change = mine.months[i]?.change;
    return `${fmtMonth(m.month)}, ${name}: ${parts.join(", ")}${change != null ? `; ${change >= 0 ? "up" : "down"} ${fmtPct(Math.abs(change))} on the month before` : ""}. ${money(mine.months[i]?.cumulative ?? 0)} in ${year.year} so far.`;
  };

  const months = year.months.length === 1 ? fmtMonth(year.months[0]!.month, { short: true }) : `${fmtMonth(year.months[0]!.month, { short: true })} – ${fmtMonth(current!.month, { short: true })}`;

  return (
    <Panel
      id="monthly-comparison-h"
      testId="monthly-comparison"
      i={1}
      title={`Monthly comparison · YTD (${months})`}
      total={money(mine.total)}
      sub={sub.join(" · ")}
      aside={
        lined ? (
          <ChartChoice<MonthView>
            label="Comparison shows"
            value={view}
            onChange={setPicked}
            options={[["sales", "Total sales"], ...(custom ? [["custom", `Custom sales · ${custom.name}`] as [MonthView, string]] : []), ["net", "Net sales"]]}
          />
        ) : undefined
      }
      legend={
        <>
          {years.map((y) => (
            <Key key={y.year} color={YEAR_FILL[year.year - y.year] ?? YEAR_FILL[2]}>{y.year}</Key>
          ))}
          {current?.current && <Key color="var(--viz-day-partial)">{year.year} partial</Key>}
          <Key color="var(--viz-running)" line>{year.year} cumulative</Key>
        </>
      }
    >
      <ComboChart
        groups={groups}
        label={`${name} per month, ${year.year} so far${earlier.length ? ` beside ${listOf(earlier)}` : ""}, with ${year.year}'s running total`}
        fmtAxis={(v) => fmtMoneyCompact(v, currency)}
        fmtRunning={(v) => fmtMoneyCompact(v, currency)}
        plotHeight={260}
        tooltip={tip}
        describe={describe}
      />
    </Panel>
  );
}

/** The dates picked day by day, then this year month by month against the years before. */
export function OverviewCharts({ ov, currency }: { ov: Overview; currency: string }) {
  const s = ov.modules.sales_overview;
  if (!s) return null;
  // This year month by month only for someone who may see it (Team & Access: "View financial reports").
  const y = s.year;
  const anyYear = !!y && (y.orders > 0 || (y.past ?? []).some((p) => p.orders > 0));
  return (
    <div className="space-y-4">
      <DailyPanel ov={ov} currency={currency} />
      {y && anyYear && <MonthlyComparison ov={ov} year={y} currency={currency} />}
    </div>
  );
}

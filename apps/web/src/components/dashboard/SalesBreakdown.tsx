"use client";
import { useState, type ReactNode } from "react";
import { customSalesMonths, dailyBreakdown, NET_SALES_MONTHS, weekdayOf, yearFigures } from "@app/shared/sales";
import { customSales, type ComponentSelection } from "@app/shared/salesCalculation";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { fmtDay, fmtLongDay, fmtMonth, fmtMoneyCompact, fmtMoneyWhole, fmtSpan, fmtWeekday, weekdayName } from "./format";
import { ChartChoice } from "./Primitives";
import { asSalesDays, dayLinesOf, hasMonthLines, showsRefunds } from "./redacted";
import { type Column, ColumnsWithTotal } from "./ColumnsWithTotal";
import type { SalesOverview } from "./types";

// The sales cards: day by day for the dates picked, and month by month for this calendar year,
// each drawn with ColumnsWithTotal. Each measures net sales, or the store's Custom sales while it
// shows it on the dashboard (named, with Shopify's net sales beside it).

/** A short colored key beside a legend label (identity is never color alone: the label says it). */
function Key({ kind, color, faded, children }: { kind: "box" | "line" | "band" | "hatch"; color: string; faded?: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {kind === "line" ? (
        <span aria-hidden className="inline-block h-0.5 w-4 rounded" style={{ background: color, opacity: 0.6 }} />
      ) : kind === "hatch" ? (
        <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: `repeating-linear-gradient(45deg, ${color} 0 1.5px, transparent 1.5px 4px)` }} />
      ) : (
        <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color, opacity: faded ? 0.45 : kind === "band" ? 0.6 : 1 }} />
      )}
      {children}
    </span>
  );
}

function Figure({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 truncate font-semibold">{value}</dd>
      {note && <dd className="truncate text-xs text-muted">{note}</dd>}
    </div>
  );
}

function TipRow({ children }: { children: ReactNode }) {
  return <div className="text-muted">{children}</div>;
}

const TIER_FILL = ["", "var(--viz-tier-1)", "var(--viz-tier-2)", "var(--viz-tier-3)"] as const;
/** Ungraded days (too few to set tiers) are one series: the ramp's middle step. */
const PLAIN_FILL = TIER_FILL[2];

/** "June complete", "July and August complete", "3 full months". */
function fullMonthsText(months: string[]): string | null {
  if (!months.length) return null;
  if (months.length > 2) return `${months.length} full months`;
  return `${months.map((m) => fmtMonth(m)).join(" and ")} complete`;
}

/** The store's Custom sales when it shows it on the dashboard (`appliedCustom` in ./redacted). */
type AppliedCustom = { name: string; components: ComponentSelection };
type Measure = "custom" | "net";

/**
 * What a sales card measures: the store's Custom sales while it shows it on the dashboard (until
 * another is picked, as the sales chart on the home page), else net sales. Shopify's net sales
 * stays one pick away and on every day and month of the card, so Custom sales never stands in for it.
 */
function useMeasure(custom: AppliedCustom | null) {
  const [picked, setPicked] = useState<Measure | null>(null);
  const measure: Measure = custom && (picked ?? "custom") === "custom" ? "custom" : "net";
  return [measure, setPicked] as const;
}

function MeasureChoice({ custom, value, onChange }: { custom: AppliedCustom | null; value: Measure; onChange: (m: Measure) => void }) {
  if (!custom) return null;
  return (
    <ChartChoice<Measure>
      label="Sales card shows"
      value={value}
      onChange={onChange}
      options={[
        ["custom", `Custom sales · ${custom.name}`],
        ["net", "Net sales"],
      ]}
    />
  );
}

/** Under the headline while Custom sales is measured: its name, and Shopify's figure beside it. */
function CustomNote({ custom, net, money }: { custom: AppliedCustom; net: number; money: (n: number) => string }) {
  return (
    <p className="mt-0.5 text-xs text-muted" data-testid="custom-measure">
      Custom sales · {custom.name}, not Shopify&apos;s figure. Shopify&apos;s net sales: <span className="tabular-nums">{money(net)}</span>
    </p>
  );
}

export function DailySalesCard({
  series,
  range,
  today,
  historyFrom,
  currency,
  custom = null,
}: {
  /** Days without `refunds` (Team & Access: "View refunds") show no refunds column. */
  series: SalesOverview["series"];
  range: { from: string; to: string };
  today: string;
  historyFrom: string | null;
  currency: string;
  /** Offered as what the days are measured by, named; each day's lines make it (`dayLinesOf`). */
  custom?: AppliedCustom | null;
}) {
  const [table, setTable] = useState(false);
  const [measure, setMeasure] = useMeasure(custom);
  const showRefunds = showsRefunds(series);
  const days = asSalesDays(series);
  const net = dailyBreakdown(days, today, historyFrom);
  const shown = measure === "custom" && custom ? custom : null;
  const b = shown
    ? dailyBreakdown(days, today, historyFrom, (d) => {
        const lines = dayLinesOf(d);
        return lines ? customSales(lines, shown.components) : 0;
      })
    : net;
  const name = shown ? `Custom sales · ${shown.name}` : "Net sales";
  const money = (n: number) => fmtMoney(n, currency);
  const whole = (n: number) => fmtMoneyWhole(n, currency);
  const hasToday = b.days.some((d) => d.status === "today");
  const hasMissing = b.days.some((d) => d.status === "not_imported");
  const n = b.days.length;
  const t = b.tiers;
  type Day = (typeof b.days)[number];
  const fillOf = (d: Day) => (t ? TIER_FILL[d.tier] : PLAIN_FILL);

  const columns: Column[] = b.days.map((d) => {
    const weekend = weekdayOf(d.day) >= 5;
    return {
      key: d.day,
      value: d.value,
      fill: fillOf(d),
      faded: d.status === "today",
      missing: d.status === "not_imported",
      shaded: weekend,
      running: d.cumulative,
      tick: {
        top: n <= 31 ? String(Number(d.day.slice(8))) : fmtDay(d.day, { year: false }),
        bottom: d.status === "today" ? "Today" : fmtWeekday(d.day),
        strong: weekend || d.status === "today",
        // Long ranges label Mondays, very long ones the first of each month.
        major: n <= 31 || (n <= 120 ? weekdayOf(d.day) === 0 : d.day.endsWith("-01")),
      },
      label: d.value !== 0 ? whole(d.value) : undefined,
      keepLabel: d.day === b.best?.day || d.status === "today",
    };
  });

  const tip = (d: Day) => {
    if (d.status === "not_imported") {
      return (
        <>
          <div className="font-medium">{fmtLongDay(d.day)}</div>
          <TipRow>Not imported: Shopify shared orders from {fmtDay(historyFrom)} on.</TipRow>
        </>
      );
    }
    const vsAvg = b.average && d.status === "complete" ? (d.value - b.average) / b.average : null;
    return (
      <>
        <div className="text-muted">{fmtLongDay(d.day)}{d.status === "today" ? " · today so far" : ""}</div>
        <div className="mt-0.5 text-sm font-semibold tabular-nums">{money(d.value)}</div>
        {shown && (
          <>
            <TipRow>{name}</TipRow>
            <TipRow>Net sales {money(d.netSales)}</TipRow>
          </>
        )}
        <TipRow>{d.orders === 1 ? "1 order" : `${fmtNum(d.orders)} orders`}{d.averageOrderValue !== null ? ` · ${money(d.averageOrderValue)} average` : ""}</TipRow>
        {showRefunds && d.refunds > 0 && <TipRow>Refunds {money(d.refunds)}</TipRow>}
        {vsAvg !== null && <TipRow>{vsAvg >= 0 ? "▲" : "▼"} {fmtPct(Math.abs(vsAvg))} {vsAvg >= 0 ? "above" : "below"} an average day</TipRow>}
        {d.cumulative !== null && (
          <div className="mt-1 flex items-center gap-1.5 text-muted">
            <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: "var(--viz-total)" }} />
            <span className="font-medium tabular-nums text-text">{money(d.cumulative)}</span> so far
          </div>
        )}
      </>
    );
  };
  const describe = (i: number) => {
    const d = b.days[i]!;
    if (d.status === "not_imported") return `${fmtLongDay(d.day)}: not imported.`;
    const what = shown ? `${name} (net sales ${money(d.netSales)})` : "net sales";
    return `${fmtLongDay(d.day)}${d.status === "today" ? ", today so far" : ""}: ${money(d.value)} ${what} from ${fmtNum(d.orders)} orders. ${money(d.cumulative ?? 0)} so far in this range.`;
  };

  const notes = [
    fullMonthsText(b.fullMonths),
    hasToday ? `${fmtDay(today, { year: false })} is today (so far)` : null,
    hasMissing ? `orders before ${fmtDay(historyFrom, { year: false })} weren't shared by Shopify` : null,
  ].filter(Boolean);
  const valueColumns = 4 + (showRefunds ? 1 : 0) + (shown ? 1 : 0);

  return (
    <div className="card animate-rise mt-4 min-w-0" style={{ ["--i" as string]: 4 }} data-testid="daily-sales">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{fmtSpan(range.from, range.to)} · Daily</p>
          <p className="mt-1 text-3xl font-semibold">{money(b.total)}</p>
          {shown && <CustomNote custom={shown} net={net.total} money={money} />}
          {notes.length > 0 && <p className="mt-0.5 text-xs text-muted first-letter:uppercase">{notes.join(" · ")}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <MeasureChoice custom={custom} value={measure} onChange={setMeasure} />
          <button className="text-xs text-muted underline" onClick={() => setTable((x) => !x)}>{table ? "Show chart" : "Show table"}</button>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Figure label="Average day" value={b.average !== null ? money(b.average) : "—"} note={hasToday ? "finished days only" : `${fmtNum(b.importedDays)} days`} />
        <Figure label="Best day" value={b.best ? money(b.best.value) : "—"} note={b.best ? fmtLongDay(b.best.day) : "no sales yet"} />
        <Figure label="Days with sales" value={`${fmtNum(b.daysWithSales)} of ${fmtNum(b.importedDays)}`} note={b.importedDays ? `${fmtPct(b.daysWithSales / b.importedDays)} of days` : undefined} />
        {b.bestWeekday ? (
          <Figure
            label="Best weekday"
            value={weekdayName(b.bestWeekday.weekday, "long")}
            note={`${money(b.bestWeekday.average)} on average`}
          />
        ) : (
          <Figure label="Orders" value={fmtNum(b.orders)} note={b.orders ? `${money(Math.round((b.total / b.orders) * 100) / 100)} ${shown ? "Custom sales" : "net"} per order` : undefined} />
        )}
      </dl>

      {table ? (
        <div className="mt-4 max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{name} per day</caption>
            <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
              <tr>
                <th className="py-1 font-normal">Day</th>
                {shown && <th className="py-1 text-right font-normal">{name}</th>}
                <th className="py-1 text-right font-normal">Net sales</th>
                <th className="py-1 text-right font-normal">Orders</th>
                <th className="py-1 text-right font-normal">Average order</th>
                {showRefunds && <th className="py-1 text-right font-normal">Refunds</th>}
                <th className="py-1 text-right font-normal">{shown ? "Custom sales so far" : "So far"}</th>
              </tr>
            </thead>
            <tbody>
              {b.days.map((d) => (
                <tr key={d.day} className="border-t border-border">
                  <td className="py-1">{fmtLongDay(d.day)}{d.status === "today" ? " (so far)" : ""}</td>
                  {d.status === "not_imported" ? (
                    <td colSpan={valueColumns} className="py-1 text-right text-muted">Not imported</td>
                  ) : (
                    <>
                      {shown && <td className="py-1 text-right tabular-nums">{money(d.value)}</td>}
                      <td className="py-1 text-right tabular-nums">{money(d.netSales)}</td>
                      <td className="py-1 text-right tabular-nums">{fmtNum(d.orders)}</td>
                      <td className="py-1 text-right tabular-nums">{d.averageOrderValue !== null ? money(d.averageOrderValue) : "—"}</td>
                      {showRefunds && <td className="py-1 text-right tabular-nums">{d.refunds ? money(d.refunds) : "—"}</td>}
                      <td className="py-1 text-right tabular-nums">{money(d.cumulative ?? 0)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {shown && <span className="font-medium text-text">{name}</span>}
            {t ? (
              <>
                {t.best !== null && <Key kind="box" color={TIER_FILL[3]}>≥ {whole(t.best)}</Key>}
                <Key kind="box" color={TIER_FILL[2]}>{t.best !== null ? `${whole(t.strong)} – ${whole(t.best)}` : `≥ ${whole(t.strong)}`}</Key>
                <Key kind="box" color={TIER_FILL[1]}>Under {whole(t.strong)}</Key>
              </>
            ) : null}
            {hasToday && <Key kind="box" color={t ? TIER_FILL[1] : PLAIN_FILL} faded>Today (so far)</Key>}
            {b.average !== null && b.average > 0 && <Key kind="line" color="var(--text)">Average day {whole(b.average)}</Key>}
            <Key kind="band" color="var(--border)">Weekend</Key>
            {hasMissing && <Key kind="hatch" color="var(--muted)">Not imported</Key>}
          </div>
          <ColumnsWithTotal
            columns={columns}
            label={`${name} per day, ${fmtSpan(range.from, range.to)}, with the running total below`}
            fmtAxis={(v) => fmtMoneyCompact(v, currency)}
            reference={b.average}
            runningLabel="Running total"
            fmtRunning={whole}
            tooltip={(i) => tip(b.days[i]!)}
            describe={describe}
            missingLabel="Not imported"
          />
        </>
      )}
    </div>
  );
}

export function MonthlySalesCard({
  year,
  historyFrom,
  currency,
  custom = null,
}: {
  year: NonNullable<SalesOverview["year"]>;
  historyFrom: string | null;
  currency: string;
  /** Offered as what the months are measured by, named; each month's lines make it (`customSalesMonths`). */
  custom?: AppliedCustom | null;
}) {
  const [table, setTable] = useState(false);
  const months = year.months;
  // Custom sales month by month needs every month's lines (an answer from before they came has none).
  const lined = months.every(hasMonthLines) ? months : null;
  const offered = lined ? custom : null;
  const [measure, setMeasure] = useMeasure(offered);
  const shown = measure === "custom" && offered ? offered : null;
  const f = shown && lined ? yearFigures(lined, customSalesMonths(shown.components)) : yearFigures(months, NET_SALES_MONTHS);
  const name = shown ? `Custom sales · ${shown.name}` : "Net sales";
  const money = (n: number) => fmtMoney(n, currency);
  const whole = (n: number) => fmtMoneyWhole(n, currency);
  const current = months.at(-1);
  const currentFigure = f.months.at(-1);
  const firstImported = months.find((m) => m.coverage !== "none");
  const anyMissing = months.some((m) => m.coverage !== "full");

  const columns: Column[] = months.map((m, i) => {
    const x = f.months[i]!;
    return {
      key: m.month,
      value: x.value,
      fill: "var(--viz-tier-2)",
      faded: m.current || m.coverage === "partial",
      missing: m.coverage === "none",
      running: x.cumulative,
      tick: { top: fmtMonth(m.month, { short: true }), bottom: m.current ? "so far" : m.coverage === "partial" ? "partial" : undefined, strong: m.current, major: true },
      label: whole(x.value),
      keepLabel: m.current || m.month === f.best?.month,
    };
  });

  const tip = (i: number) => {
    const m = months[i]!;
    const x = f.months[i]!;
    if (m.coverage === "none") {
      return (
        <>
          <div className="font-medium">{fmtMonth(m.month, { year: true })}</div>
          <TipRow>Not imported: Shopify shared orders from {fmtDay(historyFrom)} on.</TipRow>
        </>
      );
    }
    return (
      <>
        <div className="text-muted">{fmtMonth(m.month, { year: true })}{m.current ? ` · to ${fmtDay(m.to, { year: false })}` : ""}</div>
        <div className="mt-0.5 text-sm font-semibold tabular-nums">{money(x.value)}</div>
        {shown && (
          <>
            <TipRow>{name}</TipRow>
            <TipRow>Net sales {money(m.netSales)}</TipRow>
          </>
        )}
        <TipRow>{m.orders === 1 ? "1 order" : `${fmtNum(m.orders)} orders`}{m.averageOrderValue !== null ? ` · ${money(m.averageOrderValue)} average` : ""}</TipRow>
        {/* Months without `refunds` (Team & Access: "View refunds") show no refunds. */}
        {m.refunds !== undefined && m.refunds > 0 && <TipRow>Refunds {money(m.refunds)}</TipRow>}
        {m.coverage === "partial" && <TipRow>Only from {fmtDay(historyFrom, { year: false })}: earlier orders weren&apos;t shared by Shopify.</TipRow>}
        <div className="mt-1 flex items-center gap-1.5 text-muted">
          <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: "var(--viz-total)" }} />
          <span className="font-medium tabular-nums text-text">{money(x.cumulative ?? 0)}</span> this year so far
        </div>
      </>
    );
  };
  const describe = (i: number) => {
    const m = months[i]!;
    const x = f.months[i]!;
    if (m.coverage === "none") return `${fmtMonth(m.month, { year: true })}: not imported.`;
    const what = shown ? `${name} (net sales ${money(m.netSales)})` : "net sales";
    return `${fmtMonth(m.month, { year: true })}${m.current ? " so far" : ""}: ${money(x.value)} ${what} from ${fmtNum(m.orders)} orders.`;
  };

  return (
    <div className="card animate-rise mt-4 min-w-0" style={{ ["--i" as string]: 5 }} data-testid="monthly-sales">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">This year · Monthly</p>
          <p className="mt-1 text-3xl font-semibold">{money(f.total)}</p>
          {shown && <CustomNote custom={shown} net={year.total} money={money} />}
          <p className="mt-0.5 text-xs text-muted">
            {fmtSpan(`${year.year}-01-01`, current?.to ?? `${year.year}-01-01`)}
            {current ? ` · ${fmtMonth(current.month)} is month to date` : ""}
            {anyMissing && firstImported ? ` · orders before ${fmtDay(historyFrom, { year: false })} weren't shared by Shopify` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <MeasureChoice custom={offered} value={measure} onChange={setMeasure} />
          <button className="text-xs text-muted underline" onClick={() => setTable((x) => !x)}>{table ? "Show chart" : "Show table"}</button>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Figure label="Average month" value={f.average !== null ? money(f.average) : "—"} note={f.finishedMonths ? `over ${f.finishedMonths} full month${f.finishedMonths === 1 ? "" : "s"}` : "no full month yet"} />
        <Figure label="Best month" value={f.best ? money(f.best.value) : "—"} note={f.best ? fmtMonth(f.best.month) : "no sales yet"} />
        <Figure label="Orders this year" value={fmtNum(year.orders)} note={year.orders ? `${money(Math.round((f.total / year.orders) * 100) / 100)} ${shown ? "Custom sales" : "net"} per order` : undefined} />
        {current && currentFigure && <Figure label={`${fmtMonth(current.month)} so far`} value={money(currentFigure.value)} />}
      </dl>

      {table ? (
        <div className="mt-4 overflow-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{name} per month this year</caption>
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1 font-normal">Month</th>
                {shown && <th className="py-1 text-right font-normal">{name}</th>}
                <th className="py-1 text-right font-normal">Net sales</th>
                <th className="py-1 text-right font-normal">Orders</th>
                <th className="py-1 text-right font-normal">Average order</th>
                <th className="py-1 text-right font-normal">{shown ? "Custom sales, year so far" : "Year so far"}</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m, i) => {
                const x = f.months[i]!;
                return (
                  <tr key={m.month} className="border-t border-border">
                    <td className="py-1">{fmtMonth(m.month)}{m.current ? " (so far)" : m.coverage === "partial" ? " (partly imported)" : ""}</td>
                    {m.coverage === "none" ? (
                      <td colSpan={shown ? 5 : 4} className="py-1 text-right text-muted">Not imported</td>
                    ) : (
                      <>
                        {shown && <td className="py-1 text-right tabular-nums">{money(x.value)}</td>}
                        <td className="py-1 text-right tabular-nums">{money(m.netSales)}</td>
                        <td className="py-1 text-right tabular-nums">{fmtNum(m.orders)}</td>
                        <td className="py-1 text-right tabular-nums">{m.averageOrderValue !== null ? money(m.averageOrderValue) : "—"}</td>
                        <td className="py-1 text-right tabular-nums">{money(x.cumulative ?? 0)}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <Key kind="box" color="var(--viz-tier-2)">{name}</Key>
            {current && <Key kind="box" color="var(--viz-tier-2)" faded>Month so far{anyMissing ? " / partly imported" : ""}</Key>}
            {months.some((m) => m.coverage === "none") && <Key kind="hatch" color="var(--muted)">Not imported</Key>}
          </div>
          <ColumnsWithTotal
            columns={columns}
            label={`${name} per month in ${year.year}, with the year's running total below`}
            fmtAxis={(v) => fmtMoneyCompact(v, currency)}
            runningLabel="Year so far"
            fmtRunning={whole}
            tooltip={tip}
            describe={describe}
            missingLabel="Not imported"
          />
        </>
      )}
    </div>
  );
}

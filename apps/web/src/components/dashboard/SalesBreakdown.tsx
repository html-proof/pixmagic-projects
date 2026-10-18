"use client";
import { useState, type ReactNode } from "react";
import { dailyBreakdown, weekdayOf, type BreakdownDay, type SalesDay, type SalesMonth, type YearBreakdown } from "@app/shared/sales";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { fmtDay, fmtLongDay, fmtMonth, fmtMoneyCompact, fmtMoneyWhole, fmtSpan, fmtWeekday, weekdayName } from "./format";
import { Delta } from "./Primitives";
import { asSalesDays, showsRefunds } from "./redacted";
import { type Column, ColumnsWithTotal } from "./ColumnsWithTotal";

// The sales cards: day by day for the dates picked, and month by month for this calendar year,
// each drawn with ColumnsWithTotal.

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

export function DailySalesCard({
  series,
  range,
  today,
  historyFrom,
  currency,
}: {
  /** Days without `refunds` (Team & Access: "View refunds") show no refunds column. */
  series: Array<Omit<SalesDay, "refunds" | "totalSales"> & { refunds?: number; totalSales?: number }>;
  range: { from: string; to: string };
  today: string;
  historyFrom: string | null;
  currency: string;
}) {
  const [table, setTable] = useState(false);
  const showRefunds = showsRefunds(series);
  const b = dailyBreakdown(asSalesDays(series), today, historyFrom);
  const money = (n: number) => fmtMoney(n, currency);
  const whole = (n: number) => fmtMoneyWhole(n, currency);
  const hasToday = b.days.some((d) => d.status === "today");
  const hasMissing = b.days.some((d) => d.status === "not_imported");
  const n = b.days.length;
  const t = b.tiers;
  const fillOf = (d: BreakdownDay) => (t ? TIER_FILL[d.tier] : PLAIN_FILL);

  const columns: Column[] = b.days.map((d) => {
    const weekend = weekdayOf(d.day) >= 5;
    return {
      key: d.day,
      value: d.netSales,
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
      label: d.netSales !== 0 ? whole(d.netSales) : undefined,
      keepLabel: d.day === b.best?.day || d.status === "today",
    };
  });

  const tip = (d: BreakdownDay) => {
    if (d.status === "not_imported") {
      return (
        <>
          <div className="font-medium">{fmtLongDay(d.day)}</div>
          <TipRow>Not imported: Shopify shared orders from {fmtDay(historyFrom)} on.</TipRow>
        </>
      );
    }
    const vsAvg = b.average && d.status === "complete" ? (d.netSales - b.average) / b.average : null;
    return (
      <>
        <div className="text-muted">{fmtLongDay(d.day)}{d.status === "today" ? " · today so far" : ""}</div>
        <div className="mt-0.5 text-sm font-semibold tabular-nums">{money(d.netSales)}</div>
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
    return `${fmtLongDay(d.day)}${d.status === "today" ? ", today so far" : ""}: ${money(d.netSales)} net sales from ${fmtNum(d.orders)} orders. ${money(d.cumulative ?? 0)} so far in this range.`;
  };

  const notes = [
    fullMonthsText(b.fullMonths),
    hasToday ? `${fmtDay(today, { year: false })} is today (so far)` : null,
    hasMissing ? `orders before ${fmtDay(historyFrom, { year: false })} weren't shared by Shopify` : null,
  ].filter(Boolean);

  return (
    <div className="card animate-rise mt-4 min-w-0" style={{ ["--i" as string]: 4 }} data-testid="daily-sales">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{fmtSpan(range.from, range.to)} · Daily</p>
          <p className="mt-1 text-3xl font-semibold">{money(b.total)}</p>
          {notes.length > 0 && <p className="mt-0.5 text-xs text-muted first-letter:uppercase">{notes.join(" · ")}</p>}
        </div>
        <button className="text-xs text-muted underline" onClick={() => setTable((x) => !x)}>{table ? "Show chart" : "Show table"}</button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Figure label="Average day" value={b.average !== null ? money(b.average) : "—"} note={hasToday ? "finished days only" : `${fmtNum(b.importedDays)} days`} />
        <Figure label="Best day" value={b.best ? money(b.best.netSales) : "—"} note={b.best ? fmtLongDay(b.best.day) : "no sales yet"} />
        <Figure label="Days with sales" value={`${fmtNum(b.daysWithSales)} of ${fmtNum(b.importedDays)}`} note={b.importedDays ? `${fmtPct(b.daysWithSales / b.importedDays)} of days` : undefined} />
        {b.bestWeekday ? (
          <Figure
            label="Best weekday"
            value={weekdayName(b.bestWeekday.weekday, "long")}
            note={`${money(b.bestWeekday.average)} on average`}
          />
        ) : (
          <Figure label="Orders" value={fmtNum(b.orders)} note={b.orders ? `${money(Math.round((b.total / b.orders) * 100) / 100)} net per order` : undefined} />
        )}
      </dl>

      {table ? (
        <div className="mt-4 max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Net sales per day</caption>
            <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
              <tr>
                <th className="py-1 font-normal">Day</th>
                <th className="py-1 text-right font-normal">Net sales</th>
                <th className="py-1 text-right font-normal">Orders</th>
                <th className="py-1 text-right font-normal">Average order</th>
                {showRefunds && <th className="py-1 text-right font-normal">Refunds</th>}
                <th className="py-1 text-right font-normal">So far</th>
              </tr>
            </thead>
            <tbody>
              {b.days.map((d) => (
                <tr key={d.day} className="border-t border-border">
                  <td className="py-1">{fmtLongDay(d.day)}{d.status === "today" ? " (so far)" : ""}</td>
                  {d.status === "not_imported" ? (
                    <td colSpan={showRefunds ? 5 : 4} className="py-1 text-right text-muted">Not imported</td>
                  ) : (
                    <>
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
            label={`Net sales per day, ${fmtSpan(range.from, range.to)}, with the running total below`}
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

export function MonthlySalesCard({ year, historyFrom, currency }: { year: YearBreakdown; historyFrom: string | null; currency: string }) {
  const [table, setTable] = useState(false);
  const money = (n: number) => fmtMoney(n, currency);
  const whole = (n: number) => fmtMoneyWhole(n, currency);
  const months = year.months;
  const current = months.at(-1);

  let running = 0;
  const cumulative = months.map((m) => (m.coverage === "none" ? null : (running = Math.round((running + m.netSales) * 100) / 100)));
  const finished = months.filter((m) => !m.current && m.coverage === "full");
  const average = finished.length ? finished.reduce((a, m) => a + m.netSales, 0) / finished.length : null;
  const best = months.filter((m) => m.coverage !== "none" && m.netSales > 0).reduce<SalesMonth | null>((a, m) => (!a || m.netSales > a.netSales ? m : a), null);
  const firstImported = months.find((m) => m.coverage !== "none");
  const anyMissing = months.some((m) => m.coverage !== "full");

  const changeText = (c: number) => `${c >= 0 ? "▲" : "▼"} ${fmtPct(Math.abs(c))}`;
  const columns: Column[] = months.map((m, i) => ({
    key: m.month,
    value: m.netSales,
    fill: "var(--viz-tier-2)",
    faded: m.current || m.coverage === "partial",
    missing: m.coverage === "none",
    running: cumulative[i]!,
    tick: { top: fmtMonth(m.month, { short: true }), bottom: m.current ? "so far" : m.coverage === "partial" ? "partial" : undefined, strong: m.current, major: true },
    label: whole(m.netSales),
    keepLabel: m.current || m.month === best?.month,
    note: m.change !== null && !m.current ? { text: changeText(m.change), tone: m.change >= 0 ? "good" : "danger" } : undefined,
  }));

  const comparedText = (m: SalesMonth) =>
    !m.comparedWith ? null : m.current ? `vs ${fmtSpan(m.comparedWith.from, m.comparedWith.to)}` : `vs ${fmtMonth(m.comparedWith.from.slice(0, 7))}`;
  const tip = (i: number) => {
    const m = months[i]!;
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
        <div className="mt-0.5 text-sm font-semibold tabular-nums">{money(m.netSales)}</div>
        <TipRow>{m.orders === 1 ? "1 order" : `${fmtNum(m.orders)} orders`}{m.averageOrderValue !== null ? ` · ${money(m.averageOrderValue)} average` : ""}</TipRow>
        {m.refunds > 0 && <TipRow>Refunds {money(m.refunds)}</TipRow>}
        {m.change !== null && <TipRow>{changeText(m.change)} {comparedText(m)}</TipRow>}
        {m.coverage === "partial" && <TipRow>Only from {fmtDay(historyFrom, { year: false })}: earlier orders weren&apos;t shared by Shopify.</TipRow>}
        <div className="mt-1 flex items-center gap-1.5 text-muted">
          <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: "var(--viz-total)" }} />
          <span className="font-medium tabular-nums text-text">{money(cumulative[i] ?? 0)}</span> this year so far
        </div>
      </>
    );
  };
  const describe = (i: number) => {
    const m = months[i]!;
    if (m.coverage === "none") return `${fmtMonth(m.month, { year: true })}: not imported.`;
    return `${fmtMonth(m.month, { year: true })}${m.current ? " so far" : ""}: ${money(m.netSales)} net sales from ${fmtNum(m.orders)} orders${m.change !== null ? `, ${m.change >= 0 ? "up" : "down"} ${fmtPct(Math.abs(m.change))} ${comparedText(m)}` : ""}.`;
  };

  return (
    <div className="card animate-rise mt-4 min-w-0" style={{ ["--i" as string]: 5 }} data-testid="monthly-sales">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">This year · Monthly</p>
          <p className="mt-1 text-3xl font-semibold">{money(year.total)}</p>
          <p className="mt-0.5 text-xs text-muted">
            {fmtSpan(`${year.year}-01-01`, current?.to ?? `${year.year}-01-01`)}
            {current ? ` · ${fmtMonth(current.month)} is month to date` : ""}
            {anyMissing && firstImported ? ` · orders before ${fmtDay(historyFrom, { year: false })} weren't shared by Shopify` : ""}
          </p>
        </div>
        <button className="text-xs text-muted underline" onClick={() => setTable((x) => !x)}>{table ? "Show chart" : "Show table"}</button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Figure label="Average month" value={average !== null ? money(average) : "—"} note={finished.length ? `over ${finished.length} full month${finished.length === 1 ? "" : "s"}` : "no full month yet"} />
        <Figure label="Best month" value={best ? money(best.netSales) : "—"} note={best ? fmtMonth(best.month) : "no sales yet"} />
        <Figure label="Orders this year" value={fmtNum(year.orders)} note={year.orders ? `${money(Math.round((year.total / year.orders) * 100) / 100)} net per order` : undefined} />
        {current && (
          <Figure
            label={`${fmtMonth(current.month)} so far`}
            value={money(current.netSales)}
            note={current.change !== null ? <Delta value={current.change} label={comparedText(current)!} /> : "nothing comparable before it"}
          />
        )}
      </dl>

      {table ? (
        <div className="mt-4 overflow-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Net sales per month this year</caption>
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1 font-normal">Month</th>
                <th className="py-1 text-right font-normal">Net sales</th>
                <th className="py-1 text-right font-normal">Orders</th>
                <th className="py-1 text-right font-normal">Average order</th>
                <th className="py-1 text-right font-normal">Change</th>
                <th className="py-1 text-right font-normal">Year so far</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m, i) => (
                <tr key={m.month} className="border-t border-border">
                  <td className="py-1">{fmtMonth(m.month)}{m.current ? " (so far)" : m.coverage === "partial" ? " (partly imported)" : ""}</td>
                  {m.coverage === "none" ? (
                    <td colSpan={5} className="py-1 text-right text-muted">Not imported</td>
                  ) : (
                    <>
                      <td className="py-1 text-right tabular-nums">{money(m.netSales)}</td>
                      <td className="py-1 text-right tabular-nums">{fmtNum(m.orders)}</td>
                      <td className="py-1 text-right tabular-nums">{m.averageOrderValue !== null ? money(m.averageOrderValue) : "—"}</td>
                      <td className="py-1 text-right tabular-nums">{m.change !== null ? `${changeText(m.change)} ${comparedText(m)}` : "—"}</td>
                      <td className="py-1 text-right tabular-nums">{money(cumulative[i] ?? 0)}</td>
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
            <Key kind="box" color="var(--viz-tier-2)">Net sales</Key>
            {current && <Key kind="box" color="var(--viz-tier-2)" faded>Month so far{anyMissing ? " / partly imported" : ""}</Key>}
            {months.some((m) => m.coverage === "none") && <Key kind="hatch" color="var(--muted)">Not imported</Key>}
            <span>▲▼ change on the month before</span>
          </div>
          <ColumnsWithTotal
            columns={columns}
            label={`Net sales per month in ${year.year}, with the year's running total below`}
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

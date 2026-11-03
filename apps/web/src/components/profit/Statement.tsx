"use client";
import { Fragment } from "react";
import { Download } from "lucide-react";
import { categoryLabel, type ExpenseSection } from "@app/shared/expenses";
import { PROFIT_LOSS_GAP_WORDS, type ProfitLoss, type StatementGrain } from "@app/shared/profit";
import { fmtDay, fmtMonth, fmtSpan, fmtWeekday } from "@/components/dashboard/format";
import { csvField } from "@/components/sheet/sheetUi";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { PLATFORM_NAME } from "./profitUi";
import type { StatementAnswer } from "./useStatement";

// ---------------------------------------------------------------------------
// The profit and loss statement, laid out as the owner's own workbook is (docs/kpis.md "Profit and
// loss"): revenue with and without tax, the sales stats, advertising (each ad platform's synced
// spend, then the owner's), variable costs (Shopify's product costs, then the owner's), fixed costs,
// what is below operating profit, every cost together, and profit with its margin and the sitewide
// return on ad spend. A row per figure; a column for the dates as a whole, the dates they're compared
// with, the change, then one per day, week, month or year. Every figure is the server's
// (@app/shared/profit); a dash is a figure that can't be given, never a 0.
// ---------------------------------------------------------------------------

type Format = "money" | "count" | "percent" | "times";
interface Row {
  id: string;
  label: string;
  help?: string;
  format: Format;
  value: (p: ProfitLoss) => number | null | undefined;
  strong?: boolean;
  /** A profit: green above 0, red below. */
  signed?: boolean;
  /** A cost row: a rise is bad. */
  cost?: boolean;
}

const LABEL_W = "w-[10rem] min-w-[10rem] max-w-[10rem] sm:w-[16rem] sm:min-w-[16rem] sm:max-w-[16rem]";
const CELL = "whitespace-nowrap px-3 py-2 text-right tabular-nums";

const yours = (key: string) => (p: ProfitLoss) => p.yours.byCategory.find((c) => c.category === key)?.amount ?? 0;

/** The categories of a section with anything in the dates or the comparison, biggest first. */
function categoriesIn(a: StatementAnswer, section: ExpenseSection): string[] {
  const all = [a.total, a.compare, ...a.columns];
  const keys = new Set(all.flatMap((p) => p.yours.byCategory.filter((c) => c.section === section).map((c) => c.category)));
  const amount = (k: string) => Math.abs(yours(k)(a.total)) + Math.abs(yours(k)(a.compare));
  return [...keys].sort((x, y) => amount(y) - amount(x));
}

export interface StatementSection {
  id: string;
  label: string;
  rows: Row[];
}

/** The statement's sections and rows for this answer: a row for each ad platform and each category with costs. */
export function statementSections(a: StatementAnswer): StatementSection[] {
  const label = (k: string) => categoryLabel(k, a.categories);
  const costRows = (section: ExpenseSection): Row[] => categoriesIn(a, section).map((k) => ({ id: `cat-${k}`, label: label(k), format: "money", value: yours(k), cost: true, help: "Your own cost (Profit & Loss → Expenses)." }));
  const productHelp =
    a.setup.productCosts === "hidden" ? "Not shown to you." : a.setup.productCosts === "unavailable" ? "The store doesn't share its products' costs with bizinsights." : "The items sold at each product's cost per item in Shopify, synced.";
  const sections: StatementSection[] = [
    {
      id: "revenue",
      label: "Revenue",
      rows: [
        { id: "total_sales", label: "Revenue (tax included)", format: "money", value: (p) => p.totalSales, help: "What customers paid: Shopify's total sales, tax and duties included." },
        { id: "revenue", label: "Revenue before tax", format: "money", value: (p) => p.revenue, strong: true, help: "Net sales + shipping and fees charged. Profit is worked out from this: tax is collected for governments." },
        { id: "taxes", label: "Tax collected", format: "money", value: (p) => p.taxes, help: "Taxes and duties collected: never the store's income." },
      ],
    },
    {
      id: "sales",
      label: "Sales stats",
      rows: [
        { id: "orders", label: "Orders", format: "count", value: (p) => p.orders },
        { id: "units", label: "Items sold", format: "count", value: (p) => p.units },
      ],
    },
    {
      id: "advertising",
      label: "Advertising",
      rows: [
        ...a.setup.adProviders.map((pr): Row => ({ id: `ads-${pr}`, label: `${PLATFORM_NAME[pr] ?? pr} ad spend`, format: "money", value: (p) => p.adSpendBy[pr], cost: true, help: "Synced from the connected ad account; never changed here (an adjustment is a cost of its own)." })),
        ...costRows("advertising"),
        { id: "advertising", label: "Total advertising", format: "money", value: (p) => p.advertising, strong: true, cost: true },
        { id: "mer", label: "MER (marketing expense ratio)", format: "percent", value: (p) => p.mer, cost: true, help: "Total advertising ÷ revenue with tax, as your workbook works it out." },
      ],
    },
    {
      id: "variable",
      label: "Variable costs",
      rows: [
        { id: "product_costs", label: "Product costs (Shopify)", format: "money", value: (p) => (p.grossGaps.length ? null : p.productCosts), cost: true, help: productHelp },
        ...costRows("variable"),
        { id: "variable", label: "Total variable costs", format: "money", value: (p) => p.variableExAds, strong: true, cost: true },
        { id: "vcr", label: "VCR (variable cost ratio)", format: "percent", value: (p) => p.vcr, cost: true, help: "Total variable costs ÷ revenue before tax." },
      ],
    },
    {
      id: "fixed",
      label: "Fixed costs",
      rows: [
        ...costRows("fixed"),
        { id: "fixed", label: "Total fixed costs", format: "money", value: (p) => p.fixedCosts, strong: true, cost: true, help: "Each fixed cost's share of these days: a monthly cost ÷ its month's days, never taken whole off one day." },
        { id: "fcr", label: "FCR (fixed cost ratio)", format: "percent", value: (p) => p.fcr, cost: true, help: "Total fixed costs ÷ revenue before tax." },
      ],
    },
  ];
  const below = costRows("non_operating");
  if (below.length) sections.push({ id: "non_operating", label: "Below operating profit", rows: [...below, { id: "below", label: "Interest, tax and depreciation", format: "money", value: (p) => p.belowOperating, strong: true, cost: true }] });
  sections.push({
    id: "profit",
    label: "Profit",
    rows: [
      { id: "total_expenses", label: "Total expenses", format: "money", value: (p) => p.totalExpenses, strong: true, cost: true, help: "Advertising + variable + fixed costs (+ interest, tax and depreciation): each counted once." },
      { id: "profit", label: "Profit or loss", format: "money", value: (p) => p.netProfit, strong: true, signed: true, help: "Revenue before tax − total expenses. Blank when an input isn't known (below says which)." },
      { id: "margin", label: "Profit margin", format: "percent", value: (p) => p.netMargin, signed: true, help: "Profit ÷ revenue before tax." },
      { id: "roas", label: "Sitewide ROAS", format: "times", value: (p) => p.roas, help: "Revenue with tax ÷ total advertising." },
    ],
  });
  return sections;
}

const fmt = (n: number | null | undefined, format: Format, currency: string) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (format === "money") return fmtMoney(n, currency);
  if (format === "percent") return fmtPct(n);
  if (format === "times") return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)}×`;
  return fmtNum(n);
};

/** A column's heading: "Thu 1 Oct", "5–11 Oct", "Oct 2026", "2026". */
export function periodLabel(c: { key: string; from: string; to: string }, grain: StatementGrain): string {
  if (grain === "day") return `${fmtWeekday(c.from)} ${fmtDay(c.from, { year: false })}`;
  if (grain === "week") return fmtSpan(c.from, c.to);
  if (grain === "month") return fmtMonth(c.key, { short: true, year: true });
  return c.key;
}

/** The change from the comparison: a share up or down, coloured by whether it is good for profit. */
function Change({ now, before, row }: { now: number | null | undefined; before: number | null | undefined; row: Row }) {
  if (row.format === "percent" || row.format === "times" || now == null || before == null || before === 0) return <span className="text-muted/60">—</span>;
  const change = (now - before) / Math.abs(before);
  if (!Number.isFinite(change) || Math.abs(change) < 0.0005) return <span className="text-muted">0%</span>;
  const good = row.cost ? change < 0 : change > 0;
  return (
    <span className={good ? "text-good" : "text-danger"}>
      {change > 0 ? "▲" : "▼"} {fmtPct(Math.abs(change))}
    </span>
  );
}

function Figure({ value, sign }: { value: string; sign?: number | null }) {
  if (value === "—") return <span className="text-muted/60">—</span>;
  const c = typeof sign === "number" ? Math.round(sign * 100) : 0;
  return c > 0 ? <span className="text-good">{value}</span> : c < 0 ? <span className="text-danger">{value}</span> : <>{value}</>;
}

export function Statement({ a, onDownload }: { a: StatementAnswer; onDownload: (() => void) | null }) {
  const sections = statementSections(a);
  const gaps = [...new Set([...a.total.gaps, ...a.compare.gaps])];
  return (
    <section className="card min-w-0 p-0" aria-labelledby="pl-statement-h" data-testid="pl-statement">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 sm:px-5">
        <div className="min-w-0">
          <h2 id="pl-statement-h" className="font-semibold">
            Profit and loss statement
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {fmtSpan(a.range.from, a.range.to, { year: true })}, compared with {fmtSpan(a.previous.from, a.previous.to, { year: true })}. In {a.currency}; a dash is a figure that can&apos;t be given.
          </p>
        </div>
        {onDownload && (
          <button type="button" className="btn-secondary h-9 gap-2 px-3 text-sm" onClick={onDownload} data-print-hide data-testid="pl-statement-csv">
            <Download aria-hidden className="h-4 w-4" />
            Download CSV
          </button>
        )}
      </div>
      <div className="mt-3 overflow-auto overscroll-x-contain border-t border-border sm:max-h-[calc(100dvh-8rem)]" tabIndex={0} role="region" aria-label="Profit and loss statement">
        <table className="min-w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th scope="col" className={`sticky left-0 top-0 z-30 border-b border-r border-border bg-surface px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted ${LABEL_W}`}>
                Metric
              </th>
              <th scope="col" className="sticky top-0 z-20 min-w-[7.5rem] border-b border-border bg-accent/8 px-3 py-2 text-right text-xs font-semibold" title={fmtSpan(a.range.from, a.range.to, { year: true })}>
                Total
                <span className="block font-normal text-muted">{fmtSpan(a.range.from, a.range.to)}</span>
              </th>
              <th scope="col" className="sticky top-0 z-20 min-w-[7.5rem] border-b border-border bg-surface px-3 py-2 text-right text-xs font-semibold" title={fmtSpan(a.previous.from, a.previous.to, { year: true })}>
                Compared with
                <span className="block font-normal text-muted">{fmtSpan(a.previous.from, a.previous.to)}</span>
              </th>
              <th scope="col" className="sticky top-0 z-20 min-w-[5.5rem] border-b border-r border-border bg-surface px-3 py-2 text-right text-xs font-semibold">
                Change
              </th>
              {a.columns.map((c) => (
                <th key={c.key} scope="col" className="sticky top-0 z-20 min-w-[6.5rem] border-b border-border bg-surface px-3 py-2 text-right text-xs font-semibold" data-testid="pl-col">
                  {periodLabel({ key: c.key, from: c.from, to: c.to }, a.grain)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => (
              <Fragment key={s.id}>
                <tr>
                  <th scope="rowgroup" className="sticky left-0 z-10 border-b border-border bg-text px-3 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-bg">
                    {s.label}
                  </th>
                  <td colSpan={3 + a.columns.length} className="border-b border-border bg-text/90" />
                </tr>
                {s.rows.map((r) => (
                  <tr key={r.id} className="group/row" data-testid={`pl-row-${r.id}`}>
                    <th scope="row" className={`sticky left-0 z-10 border-b border-r border-border bg-surface px-3 py-2 text-left font-normal group-hover/row:bg-bg ${LABEL_W}`}>
                      <span className={`block truncate ${r.strong ? "font-semibold" : ""} ${r.format === "percent" || r.format === "times" ? "italic" : ""}`} title={r.help ? `${r.label}: ${r.help}` : r.label}>
                        {r.label}
                      </span>
                    </th>
                    <td className={`border-b border-border bg-accent/5 ${CELL} ${r.strong ? "font-semibold" : "font-medium"}`} data-testid="pl-total-cell">
                      <Figure value={fmt(r.value(a.total), r.format, a.currency)} sign={r.signed ? r.value(a.total) : undefined} />
                    </td>
                    <td className={`border-b border-border ${CELL} text-muted`}>{fmt(r.value(a.compare), r.format, a.currency)}</td>
                    <td className={`border-b border-r border-border ${CELL} text-xs`}>
                      <Change now={r.value(a.total)} before={r.value(a.compare)} row={r} />
                    </td>
                    {a.columns.map((c) => (
                      <td key={c.key} className={`border-b border-border group-hover/row:bg-bg ${CELL} ${r.strong ? "font-semibold" : ""}`}>
                        <Figure value={fmt(r.value(c), r.format, a.currency)} sign={r.signed ? r.value(c) : undefined} />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {gaps.length > 0 && (
        <div className="m-4 rounded-lg border border-warn/30 bg-warn/8 p-3 text-xs text-muted sm:mx-5" data-testid="pl-statement-gaps">
          {a.total.afterKnownCosts !== null && (
            <p className="text-sm text-text">
              Left after the costs bizinsights knows: <b className="tabular-nums">{fmtMoney(a.total.afterKnownCosts, a.currency)}</b>. Not called profit, because:
            </p>
          )}
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {gaps.map((g) => (
              <li key={g}>{PROFIT_LOSS_GAP_WORDS[g]}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const BOM = String.fromCharCode(0xfeff);

/** The statement as on screen, a CSV the owner's spreadsheet opens: a row per figure, plain numbers. */
export function statementCsv(a: StatementAnswer): string {
  const csv = (n: number | null | undefined, format: Format) => (n === null || n === undefined || !Number.isFinite(n) ? "" : format === "percent" ? `${(n * 100).toFixed(2)}%` : format === "count" ? String(Math.round(n)) : n.toFixed(2));
  const head = ["Metric", `Total (${a.range.from} to ${a.range.to})`, `Compared with (${a.previous.from} to ${a.previous.to})`, ...a.columns.map((c) => (c.from === c.to ? c.from : `${c.from} to ${c.to}`))];
  const lines: string[][] = [head];
  for (const s of statementSections(a)) {
    lines.push([s.label.toUpperCase()]);
    for (const r of s.rows) lines.push([`${r.label}${r.format === "money" ? ` (${a.currency})` : ""}`, csv(r.value(a.total), r.format), csv(r.value(a.compare), r.format), ...a.columns.map((c) => csv(r.value(c), r.format))]);
  }
  return `${BOM}${lines.map((l) => l.map((v) => csvField(v)).join(",")).join("\r\n")}\r\n`;
}

/** Hands the browser a file to save. */
export function saveFile(name: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}


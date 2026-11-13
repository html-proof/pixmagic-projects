"use client";
import type { ReactNode } from "react";
import { Coins, Percent, ShoppingCart, Wallet } from "lucide-react";
import { HelpTip } from "@/components/PageKit";
import { fmtMoney, fmtPct } from "@/lib/api";
import { Change, IconTile, MISSING, PointsChange } from "./PlKit";
import { toneOf, TONE_TEXT } from "./profitUi";
import type { StatementAnswer } from "./useStatement";

// ---------------------------------------------------------------------------
// The four figures at the top of Profit & Loss (the owner's design, 13 Nov 2026): what came in, what
// went out, what is left and what share of the revenue that is, each with its change from the dates
// compared with and what it means behind the "i". Every figure is the server's (@app/shared/profit);
// "Missing data" wherever an input isn't known, never a 0.
// ---------------------------------------------------------------------------

function Kpi({
  tone,
  icon,
  label,
  help,
  value,
  valueTone,
  change,
  versus,
  note,
  testid,
}: {
  tone: string;
  icon: ReactNode;
  label: string;
  help: ReactNode;
  value: string | null;
  valueTone?: string;
  change?: ReactNode;
  versus: string;
  note?: ReactNode;
  testid: string;
}) {
  return (
    <div
      className="home-card animate-rise flex min-w-0 items-start gap-3 p-4 sm:p-5"
      style={{ backgroundImage: `linear-gradient(135deg, color-mix(in oklab, ${tone} 8%, var(--surface)) 0%, var(--surface) 70%)` }}
      data-testid={testid}
    >
      <IconTile tone={tone} size="lg">
        {icon}
      </IconTile>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-sm text-muted">
          <span className="truncate" title={label}>
            {label}
          </span>
          <HelpTip label={label}>{help}</HelpTip>
        </p>
        <p className={`mt-1 truncate text-2xl leading-8 font-semibold tracking-[-0.02em] tabular-nums ${valueTone ?? ""}`} title={value ?? MISSING} data-testid={`${testid}-value`}>
          {value ?? <span className="text-base font-medium text-warn">{MISSING}</span>}
        </p>
        <p className="mt-1 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
          {change}
          {value !== null && <span>{versus}</span>}
        </p>
        {note && <p className="mt-1 text-xs text-muted">{note}</p>}
      </div>
    </div>
  );
}

export function KpiCards({ a, versus }: { a: StatementAnswer; /** "vs previous 30 days" */ versus: string }) {
  const t = a.total;
  const c = a.compare;
  const money = (n: number | null) => (n === null ? null : fmtMoney(n, a.currency));
  const profitTone = toneOf(t.netProfit);
  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Profit overview" data-testid="pl-overview">
      <Kpi
        tone="var(--good)"
        icon={<Wallet className="h-5 w-5" />}
        label="Revenue (Tax Incl.)"
        help="Everything your customers paid in these dates, with tax and duties included: Shopify's total sales."
        value={money(t.totalSales)}
        change={<Change now={t.totalSales} before={c.totalSales} />}
        versus={versus}
        note={
          t.revenue !== null && (
            <>
              <span className="font-medium text-text tabular-nums" data-testid="pl-card-revenue-value">
                {fmtMoney(t.revenue, a.currency)}
              </span>{" "}
              before tax
            </>
          )
        }
        testid="pl-card-total-sales"
      />
      <Kpi
        tone="var(--rose)"
        icon={<ShoppingCart className="h-5 w-5" />}
        label="Total Expenses"
        help="Every cost of these dates added up: product costs, advertising, your other variable costs, fixed costs, and interest, tax and the like. Each is counted once."
        value={money(t.totalExpenses)}
        change={<Change now={t.totalExpenses} before={c.totalExpenses} cost />}
        versus={versus}
        note={t.totalExpenses === null ? "A cost isn't known for these dates yet: the Expenses tab says which." : undefined}
        testid="pl-card-expenses"
      />
      <Kpi
        tone="var(--violet)"
        icon={<Coins className="h-5 w-5" />}
        label="Profit (After Tax)"
        help="What is left for the business: revenue before tax, less total expenses. The sales tax you collected (GST or VAT) is taken out first, because it is passed on to the government."
        value={money(t.netProfit)}
        valueTone={profitTone ? TONE_TEXT[profitTone] : undefined}
        change={<Change now={t.netProfit} before={c.netProfit} />}
        versus={versus}
        note={t.netProfit === null && t.afterKnownCosts !== null ? `Left after the costs known: ${fmtMoney(t.afterKnownCosts, a.currency)}. Not called profit yet.` : undefined}
        testid="pl-card-profit"
      />
      <Kpi
        tone="var(--info)"
        icon={<Percent className="h-5 w-5" />}
        label="Profit Margin"
        help="Profit as a share of revenue before tax: of every 100 you keep from sales, how much is profit."
        value={t.netMargin === null ? null : fmtPct(t.netMargin)}
        valueTone={profitTone ? TONE_TEXT[profitTone] : undefined}
        change={<PointsChange now={t.netMargin} before={c.netMargin} />}
        versus={versus}
        testid="pl-card-margin"
      />
    </section>
  );
}

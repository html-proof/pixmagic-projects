"use client";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { fmtRelative } from "./format";
import { Badge, Empty, Panel, Stat, type Tone } from "./Primitives";
import type { ProfitCardFigures } from "./profitFigures";
import type { ProfitModule, ReportStatus, ShopifyCheckModule, ShopifySessionsModule } from "./types";

/**
 * Shopify's own report figures (packages/core/src/reports/shopify.ts): its sessions and visitors,
 * its gross profit, and the check of our sales figures against its sales report. Each shows what
 * Shopify answered, says plainly when it couldn't, and never fills in a number of its own.
 */

/** Why there is nothing to show yet, in words. */
function statusNote(status: ReportStatus): string | null {
  switch (status) {
    case "loading":
      return "Asking Shopify… This updates by itself in a moment.";
    case "access_denied":
      return "Shopify didn't let bizinsights read its reports. Its reports API also needs Shopify's approval for customer data, which bizinsights is waiting on.";
    case "unsupported":
      return "Shopify can't run this report for this store (some reports need a higher Shopify plan).";
    case "failed":
      return "Couldn't reach Shopify's reports just now. We'll try again in a few minutes.";
    default:
      return null;
  }
}

/** "as of 4:40 pm" for a window cut at a time of day, or "updated 3 minutes ago". */
export function asOfWords(m: { asOf: string | null; until: string | null }): string | null {
  if (m.until) {
    const [h, min] = m.until.split(":").map(Number);
    const t = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(Date.UTC(2026, 0, 1, h ?? 0, min ?? 0)));
    return `up to ${t} today, store time`;
  }
  const r = fmtRelative(m.asOf);
  return r ? `fetched ${r}` : null;
}

export function ShopifySessionsCard({ m }: { m: ShopifySessionsModule }) {
  const c = m.current;
  const note = statusNote(m.status);
  const when = asOfWords(m);
  return (
    <Panel
      id="shopify-sessions"
      title="Sessions and visitors (Shopify)"
      help={`Shopify Analytics' own figures: online store sessions (one ends after 30 minutes idle), online store visitors (the different shoppers over the whole dates, as Shopify counts them: people, not sessions, and never a sum of the days) and its conversion rate, bot sessions left out by Shopify's own classification.${when ? ` ${when[0]!.toUpperCase()}${when.slice(1)}.` : ""}`}
    >
      {!c ? (
        <Empty>{note}</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Sessions" value={c.sessions === null ? "—" : fmtNum(c.sessions)} />
          <Stat label="Online store visitors" value={c.visitors === null ? "—" : fmtNum(c.visitors)} />
          <Stat label="Conversion rate" value={fmtPct(c.conversionRate)} />
          <Stat label="Pageviews" value={c.pageviews === null ? "—" : fmtNum(c.pageviews)} note={c.sessions && c.pageviews !== null ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(c.pageviews / c.sessions)} per session` : undefined} />
          <Stat label="Added to cart" value={c.cartSessions === null ? "—" : fmtNum(c.cartSessions)} note="Sessions" />
          <Stat label="Reached checkout" value={c.checkoutSessions === null ? "—" : fmtNum(c.checkoutSessions)} note="Sessions" />
          <Stat label="Completed checkout" value={c.completedSessions === null ? "—" : fmtNum(c.completedSessions)} tone="good" note="Sessions" />
        </div>
      )}
    </Panel>
  );
}

/**
 * Shopify's gross profit for the dates. `f` (`profitCardFigures`): whether any sale had a cost
 * recorded, and the net profit Business profit overview gives for the same store and dates, or why
 * there is none in its words, so the two never disagree.
 */
export function ProfitCard({ m, currency, f }: { m: ProfitModule; currency: string; f: ProfitCardFigures }) {
  const c = m.current;
  const money = (n: number | null) => (n === null ? "—" : fmtMoney(n, currency));
  const note = statusNote(m.status);
  const uncosted = c && c.netSalesWithoutCost !== null && c.netSalesWithoutCost > 0 ? c.netSalesWithoutCost : 0;
  const costedShare = c && c.netSalesWithCost !== null && c.netSalesWithoutCost !== null && c.netSalesWithCost + c.netSalesWithoutCost > 0 ? c.netSalesWithCost / (c.netSalesWithCost + c.netSalesWithoutCost) : null;
  return (
    <Panel
      id="profit"
      title="Gross profit (Shopify)"
      help="Shopify's gross profit: net sales less the cost of the goods sold, from the cost per item recorded with each sale. Not net profit: fees, shipping costs, apps, staff and ads aren't taken off."
    >
      {!c ? (
        <Empty>{note}</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Gross profit" value={money(c.grossProfit)} />
            {/* Shopify's 0 for sales none of which had a cost per item isn't a cost. */}
            <Stat label="Cost of goods sold" value={f.noCostRecorded ? "Not recorded in Shopify" : money(c.costOfGoodsSold)} />
            <Stat label="Margin where cost is known" value={fmtPct(c.marginOnCosted)} note={c.profitOnCosted !== null ? `${money(c.profitOnCosted)} on ${money(c.netSalesWithCost)} of sales` : undefined} />
            <Stat label="Net profit" value={f.net === null ? "Not available" : money(f.net)} note={f.netNote} />
          </div>
          {uncosted > 0 && (
            <p className="alert alert-warn mt-4 text-sm" data-testid="profit-missing-cost">
              {money(uncosted)} of net sales{costedShare !== null ? ` (${fmtPct(1 - costedShare)})` : ""} had no cost recorded in Shopify, so their cost isn&apos;t in the cost of goods sold and gross profit includes them in full. Add a cost per item to those products in Shopify for a complete figure.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

const CHECK_LABEL: Record<string, string> = {
  grossSales: "Gross sales",
  discounts: "Discounts",
  returns: "Returns",
  netSales: "Net sales",
  shipping: "Shipping charges",
  duties: "Duties",
  additionalFees: "Additional fees",
  taxes: "Taxes",
  totalSales: "Total sales",
  orders: "Orders",
};

const STATE: Record<string, { tone: Tone; label: string }> = {
  match: { tone: "good", label: "Matches" },
  delay: { tone: "warn", label: "Catching up" },
  differs: { tone: "danger", label: "Differs" },
  unknown: { tone: "neutral", label: "Not reported" },
};

/** Our sales figures against Shopify's sales report for the same dates, line by line. */
export function ShopifyCheckCard({ m, currency }: { m: ShopifyCheckModule; currency: string }) {
  const note = statusNote(m.status);
  const when = asOfWords(m);
  const fmt = (metric: string, n: number | null) => (n === null ? "—" : metric === "orders" ? fmtNum(n) : fmtMoney(n, currency));
  return (
    <Panel
      id="shopify-check"
      title="Checked against Shopify"
      help={`These dates in Shopify's own sales report, next to the figures above${when ? `, ${when}` : ""}. They should agree to the cent: both come from Shopify's sales records.`}
      aside={m.matches === null ? null : m.matches ? <Badge tone="good">All match</Badge> : <Badge tone="warn">See differences</Badge>}
    >
      {!m.rows ? (
        <Empty>{note}</Empty>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[26rem] text-sm" data-testid="shopify-check-table">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-1 pb-2 font-normal">Figure</th>
                <th className="px-1 pb-2 text-right font-normal">bizinsights</th>
                <th className="px-1 pb-2 text-right font-normal">Shopify</th>
                <th className="px-1 pb-2 text-right font-normal">Difference</th>
                <th className="px-1 pb-2 text-right font-normal" />
              </tr>
            </thead>
            <tbody>
              {m.rows.map((r) => (
                <tr key={r.metric} className="border-t border-border">
                  <td className="px-1 py-2">{CHECK_LABEL[r.metric] ?? r.metric}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{fmt(r.metric, r.ours)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{fmt(r.metric, r.shopify)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{r.difference === null || r.difference === 0 ? "—" : fmt(r.metric, r.difference)}</td>
                  <td className="px-1 py-2 text-right">
                    <Badge tone={STATE[r.state]!.tone}>{STATE[r.state]!.label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {m.rows.some((r) => r.state === "delay") && (
            <p className="mt-3 text-xs text-muted">Catching up: changes from Shopify are still being counted here, or Shopify&apos;s report hasn&apos;t included the newest orders yet. This settles by itself within minutes.</p>
          )}
        </div>
      )}
    </Panel>
  );
}

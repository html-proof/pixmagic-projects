"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { Coins } from "lucide-react";
import { seesModule } from "@app/shared/access";
import type { ExpenseCategory } from "@app/shared/expenses";
import { PROFIT_GAP_WORDS } from "@app/shared/expenses";
import { canManage, useApp } from "@/components/AppContext";
import { fmtMoney, fmtPct } from "@/lib/api";
import { BEING_READ, UNAVAILABLE } from "@/components/dashboard/AdsCommon";
import { shownFigures } from "@/components/dashboard/adFigures";
import { DemoChip } from "@/components/dashboard/Advertising";
import { fmtTimes } from "@/components/dashboard/format";
import { costsOf, profitOf, type CostState, type ProductCostState } from "@/components/dashboard/profitFigures";
import type { AdsModule, Overview } from "@/components/dashboard/types";
import { AdCard, CardLink } from "./AdCard";
import { PLATFORM } from "./AdvertisingUi";
import { shopifyMargin } from "./Insights";

// ---------------------------------------------------------------------------
// Did the advertising make money? Two answers kept apart. What the platforms credit to their ads (their
// purchase value) less what they cost: a return on spend, before the cost of the products sold, so a
// ROAS of 4× isn't by itself a profit; with Shopify's margin on the sales it has a cost for, what that
// leaves once the products are paid for, as an estimate, and the ROAS that only just pays for them. Then
// the whole store's net profit for the dates (revenue less product costs, ad spend and the owner's own
// costs), the same figure as the dashboard's Business profit overview (profitFigures.ts), or why not.
// ---------------------------------------------------------------------------

/** The owner's costs that are Shopify's and payments' (Settings → Costs categories). */
const FEES: ReadonlySet<ExpenseCategory> = new Set(["shopify_plan", "shopify_apps", "payment_fees"]);
const PRODUCT_WORDS: Record<Exclude<ProductCostState, "known">, string> = { loading: "Loading…", missing: "Not available", unavailable: "Not available", not_recorded: "Not recorded in Shopify" };
const AD_WORDS: Record<Exclude<CostState, "known">, string> = { loading: "Loading…", missing: "Not connected", unavailable: UNAVAILABLE };

function Line({ label, value, sub, strong = false, tone, testid }: { label: ReactNode; value: ReactNode; sub?: ReactNode; strong?: boolean; tone?: "good" | "bad"; testid?: string }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${strong ? "rounded-lg bg-good/10 px-2.5 py-2" : "px-0.5"}`} data-testid={testid}>
      <div className="min-w-0">
        <p className={`text-sm ${strong ? "font-semibold" : "text-text/80"}`}>{label}</p>
        {sub && <p className="text-[11px] text-muted">{sub}</p>}
      </div>
      <p className={`shrink-0 tabular-nums ${strong ? "text-base font-bold" : "text-sm font-medium"} ${tone === "bad" ? "text-danger" : tone === "good" ? "text-good" : ""}`}>{value}</p>
    </div>
  );
}

/** What the platforms' purchases leave after the spend, and after the products at Shopify's margin. */
export function adReturn(a: AdsModule, margin: number | null) {
  const t = shownFigures(a).totals;
  if (!t || t.purchaseValue === null) return null;
  const afterSpend = Math.round((t.purchaseValue - t.spend) * 100) / 100;
  const afterProducts = margin === null ? null : Math.round((t.purchaseValue * margin - t.spend) * 100) / 100;
  return { spend: t.spend, value: t.purchaseValue, roas: t.purchases ? t.roas : null, afterSpend, afterProducts, breakEven: margin && margin > 0 ? 1 / margin : null };
}

export function ProfitSummary({ ov, full = false }: { ov: Overview; full?: boolean }) {
  const { access, workspace } = useApp();
  const a = ov.modules.ads;
  const currency = ov.store.currency;
  const money = (n: number) => fmtMoney(n, currency);
  const adMoney = (n: number) => fmtMoney(n, a?.currency ?? currency);
  const margin = a ? shopifyMargin(ov, a) : null;
  const r = a ? adReturn(a, margin) : null;
  const costsOn = seesModule(access, "profit");
  const k = costsOf(ov, currency, true);
  const profit = profitOf(ov, k, { offered: true, shown: true }, costsOn);
  const byCategory = ov.modules.expenses?.current.byCategory ?? [];
  const fees = byCategory.filter((c) => FEES.has(c.category)).reduce((n, c) => n + c.amount, 0);
  const other = byCategory.filter((c) => !FEES.has(c.category)).reduce((n, c) => n + c.amount, 0);
  const manageCosts = canManage(workspace.role);
  return (
    <AdCard
      id="ads-profit"
      title="Profitability summary"
      sub="What the ads bring back against what they cost, then your whole store's profit."
      icon={Coins}
      tint="green"
      action={full ? undefined : <CardLink href="/advertising/profitability">View details</CardLink>}
    >
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          From the platforms&apos; purchases {a?.demo && <DemoChip small />}
        </p>
        {r ? (
          <>
            <Line label="Ad spend" value={adMoney(r.spend)} testid="profit-ad-spend" />
            <Line label="Attributed revenue" sub="Purchase value, the platforms' own count" value={adMoney(r.value)} testid="profit-attributed" />
            <Line label="ROAS" sub="Attributed revenue ÷ ad spend" value={r.roas === null ? "—" : fmtTimes(r.roas)} />
            <Line strong label="Advertising profit before product costs" value={adMoney(r.afterSpend)} tone={r.afterSpend < 0 ? "bad" : undefined} testid="profit-after-spend" />
            {r.afterProducts !== null && r.breakEven !== null ? (
              <>
                <Line
                  label="After product costs (estimate)"
                  sub={`At Shopify's ${fmtPct(margin)} margin on sales with a cost`}
                  value={adMoney(r.afterProducts)}
                  tone={r.afterProducts < 0 ? "bad" : "good"}
                  testid="profit-after-products"
                />
                <Line label="Break-even ROAS" sub="The ROAS that just pays for the products sold" value={fmtTimes(r.breakEven)} testid="profit-break-even" />
              </>
            ) : (
              <p className="px-0.5 text-[11px] text-muted">
                {a?.demo ? "Not set against your store with the demo's simulated spend." : "What's left after product costs needs Shopify's profit report with a cost per item on the products sold."}
              </p>
            )}
          </>
        ) : (
          <p className="px-0.5 text-sm text-muted">{a ? BEING_READ : "No ad account connected: nothing spent to set against."}</p>
        )}
      </div>
      <div className="mt-4 space-y-2 border-t border-border pt-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Your whole store (Shopify)</p>
        {profit ? (
          <>
            <Line label="Revenue" sub="Net sales, shipping and fees, without tax" value={money(profit.revenue)} />
            {costsOn && <Line label="Product costs" value={k.productCosts !== null ? money(k.productCosts) : PRODUCT_WORDS[k.productState as Exclude<ProductCostState, "known">]} />}
            <Line label="Ad spend" value={k.adSpend !== null ? money(k.adSpend) : AD_WORDS[k.adState as Exclude<CostState, "known">]} />
            <Line label="Shopify and payment fees" sub="Your costs: Shopify plan, apps, payment fees" value={money(fees)} />
            <Line label="Other expenses" sub="Your other costs (Settings → Costs)" value={money(other)} />
            <Line
              strong
              label="Net profit"
              value={profit.value === null ? "Not known yet" : money(profit.value)}
              tone={profit.value !== null && profit.value < 0 ? "bad" : undefined}
              testid="profit-net"
            />
            {profit.value === null && <p className="px-0.5 text-[11px] text-muted">{profit.gaps.map((g) => PROFIT_GAP_WORDS[g]).join(" ")}</p>}
            {manageCosts && (ov.modules.expenses?.count === 0 || profit.gaps.includes("costs_not_complete")) && (
              <Link href="/settings/costs" className="px-0.5 text-xs font-medium text-accent hover:underline print:hidden">
                {ov.modules.expenses?.count === 0 ? "Add your costs" : "Review your costs"}
              </Link>
            )}
          </>
        ) : (
          <p className="px-0.5 text-sm text-muted">Net profit needs your store&apos;s sales and costs, which you aren&apos;t shown.</p>
        )}
      </div>
      <p className="mt-3 text-xs text-muted">
        A ROAS above 1 means the platforms credit more in purchases than the ads cost, not that you made money: the products, fees and your other costs come out of it first.
      </p>
      {full && a && <ByPlatform a={a} margin={margin} />}
    </AdCard>
  );
}

/** Each platform's own return on its spend, and the store's sales Shopify credits to its tagged ads beside it. */
function ByPlatform({ a, margin }: { a: AdsModule; margin: number | null }) {
  const money = (n: number) => fmtMoney(n, a.currency);
  return (
    <div className="mt-5 border-t border-border pt-4" data-testid="profit-by-platform">
      <h3 className="text-sm font-semibold">By platform</h3>
      <div className="-mx-1 mt-2 overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="px-1 pb-2 font-normal">Platform</th>
              <th className="px-1 pb-2 text-right font-normal">Spend</th>
              <th className="px-1 pb-2 text-right font-normal">Attributed revenue (platform&apos;s count)</th>
              <th className="px-1 pb-2 text-right font-normal">ROAS</th>
              <th className="px-1 pb-2 text-right font-normal">Before product costs</th>
              {margin !== null && <th className="px-1 pb-2 text-right font-normal">After product costs (estimate)</th>}
              <th className="px-1 pb-2 text-right font-normal">Sales Shopify credits to its tagged ads</th>
            </tr>
          </thead>
          <tbody>
            {a.byProvider.map((p) => {
              const P = PLATFORM[p.provider];
              const t = shownFigures(p).totals;
              const sourced = a.sourced?.find((x) => x.provider === p.provider);
              const after = t && t.purchaseValue !== null ? t.purchaseValue - t.spend : null;
              const est = t && t.purchaseValue !== null && margin !== null ? t.purchaseValue * margin - t.spend : null;
              return (
                <tr key={p.provider} className="border-t border-border" data-testid={`profit-platform-${p.provider}`}>
                  <td className="px-1 py-2">
                    <span className="inline-flex items-center gap-2 font-medium">
                      <P.Icon size={16} />
                      {P.name}
                    </span>
                  </td>
                  <td className="px-1 py-2 text-right tabular-nums">{t ? money(t.spend) : UNAVAILABLE}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{t ? (t.purchaseValue === null ? BEING_READ : money(t.purchaseValue)) : UNAVAILABLE}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{t && t.purchases ? fmtTimes(t.roas) : "—"}</td>
                  <td className={`px-1 py-2 text-right tabular-nums ${after !== null && after < 0 ? "text-danger" : ""}`}>{after === null ? "—" : money(after)}</td>
                  {margin !== null && <td className={`px-1 py-2 text-right tabular-nums ${est !== null && est < 0 ? "text-danger" : ""}`}>{est === null ? "—" : money(est)}</td>}
                  <td className="px-1 py-2 text-right tabular-nums">{sourced ? money(sourced.sales) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        The estimate applies Shopify&apos;s margin on every sale with a cost to the platforms&apos; purchase value: the products those purchases were for may cost more or less. Shopify&apos;s credit is the
        orders whose last visit came through the platform&apos;s tagged ad links (Shopify attribution), counted once whatever the platform claims.
      </p>
    </div>
  );
}

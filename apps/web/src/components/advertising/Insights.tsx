"use client";
import { AlertTriangle, Info, Lightbulb, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import { advertisingInsights, type AdInsightTone } from "@app/shared/adInsights";
import { fmtMoney, fmtPct } from "@/lib/api";
import { shownFigures } from "@/components/dashboard/adFigures";
import { fmtSpan, fmtTimes } from "@/components/dashboard/format";
import type { AdsModule, Overview } from "@/components/dashboard/types";
import { AdCard, EmptyNote } from "./AdCard";

// ---------------------------------------------------------------------------
// "Key insights": a few sentences from figures the page already shows (advertisingInsights in
// @app/shared/adInsights): what changed, which platform returns more, what ROAS pays for at the store's
// margin. A figure not known leaves its sentence out.
// ---------------------------------------------------------------------------

const TONE: Record<AdInsightTone, { icon: LucideIcon; ink: string }> = {
  good: { icon: TrendingUp, ink: "text-good" },
  bad: { icon: TrendingDown, ink: "text-danger" },
  warn: { icon: AlertTriangle, ink: "text-warn" },
  info: { icon: Info, ink: "text-sky-600 dark:text-sky-400" },
};

/** Shopify's gross margin on the sales it has a cost for, when it can be set against this spend. */
export function shopifyMargin(ov: Overview, a: AdsModule): number | null {
  const p = ov.modules.profit;
  if (a.demo || a.currency !== ov.store.currency || p?.status !== "ready" || !p.current) return null;
  return p.current.marginOnCosted;
}

export function KeyInsights({ a, ov }: { a: AdsModule; ov: Overview }) {
  const totals = shownFigures(a).totals;
  const insights = advertisingInsights(
    {
      platforms: a.byProvider.flatMap((p) => {
        const t = shownFigures(p).totals;
        return t ? [{ provider: p.provider, spend: t.spend, purchases: t.purchases, purchaseValue: t.purchaseValue, roas: t.roas }] : [];
      }),
      totals: totals && { spend: totals.spend, purchases: totals.purchases, purchaseValue: totals.purchaseValue, roas: totals.roas },
      deltas: a.compared ? { spend: a.deltas.spend, purchases: a.deltas.purchases, purchaseValue: a.deltas.purchaseValue } : null,
      versus: a.compared ? `vs ${fmtSpan(a.compared.previous.from, a.compared.previous.to)}` : null,
      margin: shopifyMargin(ov, a),
      demo: a.demo,
    },
    { money: (n) => fmtMoney(n, a.currency), pct: (n) => fmtPct(n), times: (n) => fmtTimes(n) },
  );
  return (
    <AdCard id="ads-insights" title="Key insights" sub="What stands out in these dates, from the figures on this page." icon={Lightbulb} tint="amber">
      {insights.length === 0 ? (
        <EmptyNote>Nothing stands out yet: insights show once the platforms have reported spend and purchases for these dates.</EmptyNote>
      ) : (
        <ul className="space-y-3">
          {insights.map((i) => {
            const T = TONE[i.tone];
            return (
              <li key={i.id} className="flex gap-2.5 text-sm" data-testid={`ads-insight-${i.id}`}>
                <T.icon aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${T.ink}`} strokeWidth={2.4} />
                <span>{i.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </AdCard>
  );
}

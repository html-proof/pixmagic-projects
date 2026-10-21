"use client";
import { RECOMMENDATION_RULES, type AdsRecommendation } from "@app/shared/adsAnalytics";
import { Badge } from "@/components/dashboard/Primitives";
import { fmtPct } from "@/lib/api";
import { Section } from "./ui";

/** Section 7: rule-based recommendations, each saying what it saw, and the rules themselves. */
export function RecommendationsSection({ recommendations, demo }: { recommendations: Array<AdsRecommendation & { simulated: boolean }> | null; demo: boolean }) {
  const R = RECOMMENDATION_RULES;
  return (
    <Section id="recommendations" title="Performance recommendations" help="Plain rules over the campaign figures for these dates, each with what it saw. They point at what to look into; they change nothing." demo={demo}>
      {demo && (
        <p className="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn" data-testid="ga-recommendations-simulated">
          Derived from simulated data: these recommendations describe the demo&apos;s generated campaigns, not a real account.
        </p>
      )}
      {!recommendations ? (
        <p className="text-sm text-muted">Recommendations need the &ldquo;View campaigns&rdquo; permission.</p>
      ) : recommendations.length === 0 ? (
        <p className="text-sm text-muted">Nothing stands out in these dates.</p>
      ) : (
        <ul className="space-y-3" data-testid="ga-recommendations">
          {recommendations.map((r, i) => (
            <li key={`${r.code}:${r.campaignId}:${i}`} className="rounded-lg border border-border p-3" data-code={r.code}>
              <p className="flex flex-wrap items-center gap-2 font-medium">
                <Badge tone={r.severity === "attention" ? "warn" : "good"}>{r.severity === "attention" ? "Look into" : "Opportunity"}</Badge>
                {r.title}
              </p>
              <p className="mt-1 text-sm text-muted">{r.detail}</p>
            </li>
          ))}
        </ul>
      )}
      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer select-none text-accent underline-offset-2 hover:underline">The rules</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>High spend, low return: at least {fmtPct(R.highSpendShare)} of the spend with a ROAS under {R.lowRoas}×.</li>
          <li>Few clicks: a click-through rate under {fmtPct(R.lowCtr)} with at least {R.lowCtrImpressions.toLocaleString()} impressions.</li>
          <li>Clicks getting dearer: the cost per click up {fmtPct(R.trendUp)} or more between the first and second half of the dates (at least {R.trendClicks} clicks in each).</li>
          <li>Converting better: the conversion rate up {fmtPct(R.trendUp)} or more between the two halves.</li>
          <li>Room for budget: a ROAS of {R.opportunityRoas}× or more having used {fmtPct(R.opportunityBudgetUse)} or more of the budget.</li>
        </ul>
      </details>
    </Section>
  );
}

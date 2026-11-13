"use client";
import type { AdsMetrics } from "@app/shared/adsAnalytics";
import { Stat } from "@/components/dashboard/Primitives";
import { Section, figureWriters } from "./ui";

/** Section 1: the eight headline figures for the dates. */
export function OverviewSection({ current, currency, demo }: { current: AdsMetrics; currency: string; demo: boolean }) {
  const w = figureWriters(currency);
  return (
    <Section id="overview" title="Overview" help={`In ${currency}. CTR = clicks ÷ impressions · CPC = spend ÷ clicks · conversion rate = conversions ÷ clicks · cost per conversion = spend ÷ conversions · ROAS = conversion value ÷ spend.`} demo={demo}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="ga-overview-cards">
        <Stat label="Total spend" value={w.money(current.spend)} />
        <Stat label="Total impressions" value={w.num(current.impressions)} />
        <Stat label="Total clicks" value={w.num(current.clicks)} />
        <Stat label="CTR" value={w.pct(current.ctr)} />
        <Stat label="Average CPC" value={w.money(current.cpc)} />
        <Stat label="Conversions" value={w.num(current.conversions)} />
        <Stat label="Conversion rate" value={w.pct(current.conversionRate)} />
        <Stat label="ROAS" value={w.times(current.roas)} />
      </div>
      <p className="mt-3 text-xs text-muted">
        Conversion value {w.money(current.conversionValue)} · cost per conversion {w.money(current.costPerConversion)} · cost per 1,000 impressions {w.money(current.cpm)}.
      </p>
    </Section>
  );
}

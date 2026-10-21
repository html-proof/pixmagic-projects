"use client";
import type { AdsMetrics } from "@app/shared/adsAnalytics";
import { Delta, NeutralDelta, Stat } from "@/components/dashboard/Primitives";
import { fmtSpan } from "@/components/dashboard/format";
import type { AdsDeltas } from "@/lib/googleAds";
import { Section, figureWriters } from "./ui";

/** Section 1: the eight headline figures for the dates, each with its change against the dates compared with. */
export function OverviewSection({
  current,
  deltas,
  previous,
  currency,
  demo,
  compared,
}: {
  current: AdsMetrics;
  deltas: AdsDeltas;
  previous: AdsMetrics | null;
  currency: string;
  demo: boolean;
  compared: { from: string; to: string } | null;
}) {
  const w = figureWriters(currency);
  const label = compared ? `vs ${fmtSpan(compared.from, compared.to)}` : "vs before";
  const change = (k: keyof AdsMetrics, kind: "neutral" | "good" | "cost") => {
    if (!previous) return <span className="text-xs text-muted">no earlier data to compare</span>;
    const v = deltas[k];
    return kind === "neutral" ? <NeutralDelta value={v} label={label} /> : <Delta value={v} invert={kind === "cost"} label={label} />;
  };
  return (
    <Section id="overview" title="Overview" help={`In ${currency}. CTR = clicks ÷ impressions · CPC = spend ÷ clicks · conversion rate = conversions ÷ clicks · cost per conversion = spend ÷ conversions · ROAS = conversion value ÷ spend.`} demo={demo}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="ga-overview-cards">
        <Stat label="Total spend" value={w.money(current.spend)} note={change("spend", "neutral")} />
        <Stat label="Total impressions" value={w.num(current.impressions)} note={change("impressions", "good")} />
        <Stat label="Total clicks" value={w.num(current.clicks)} note={change("clicks", "good")} />
        <Stat label="CTR" value={w.pct(current.ctr)} note={change("ctr", "good")} />
        <Stat label="Average CPC" value={w.money(current.cpc)} note={change("cpc", "cost")} />
        <Stat label="Conversions" value={w.num(current.conversions)} note={change("conversions", "good")} />
        <Stat label="Conversion rate" value={w.pct(current.conversionRate)} note={change("conversionRate", "good")} />
        <Stat label="ROAS" value={w.times(current.roas)} note={change("roas", "good")} />
      </div>
      <p className="mt-3 text-xs text-muted">
        Conversion value {w.money(current.conversionValue)} · cost per conversion {w.money(current.costPerConversion)} · cost per 1,000 impressions {w.money(current.cpm)}.
      </p>
    </Section>
  );
}

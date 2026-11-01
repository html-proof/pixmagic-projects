"use client";
import { Coins } from "lucide-react";
import { AdvertisingBody, AdvertisingHeader } from "@/components/advertising/AdvertisingUi";
import { KeyInsights } from "@/components/advertising/Insights";
import { PlatformShare } from "@/components/advertising/PerformanceCharts";
import { ProfitSummary } from "@/components/advertising/Profitability";
import { useAdvertising } from "@/components/advertising/useAdvertising";

/**
 * Profitability: did the advertising make money? What the platforms credit to their ads against what
 * they cost (a return on spend, before the products sold), with Shopify's margin what that leaves and the
 * ROAS that only just pays for the products, each platform on its own; then the whole store's net profit
 * from every cost bizinsights knows (Settings → Costs), or why it can't be given yet.
 */
export default function AdProfitabilityPage() {
  const s = useAdvertising();
  return (
    <>
      <AdvertisingHeader
        title="Profitability"
        icon={<Coins aria-hidden className="h-5 w-5 text-accent" />}
        sub="A ROAS of 4× isn't a profit by itself: the products, fees and your other costs come out of what the ads bring back. Here is what's left, from the platforms' figures and your store's own."
        r={s.dates}
        shown={s.shown}
        current={!s.older}
      />
      <AdvertisingBody s={s} what="your advertising profitability">
        {(ov) => (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <ProfitSummary ov={ov} full />
            {ov.modules.ads && (
              <div className="space-y-4">
                <KeyInsights a={ov.modules.ads} ov={ov} />
                <PlatformShare a={ov.modules.ads} />
              </div>
            )}
          </div>
        )}
      </AdvertisingBody>
    </>
  );
}

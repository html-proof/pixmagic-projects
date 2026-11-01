"use client";
import { Megaphone } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { AdFunnel } from "@/components/advertising/AdFunnel";
import { AdvertisingBody, AdvertisingHeader, DownloadCsv, MeasuresDiffer, NotConnected, SyncedNow } from "@/components/advertising/AdvertisingUi";
import { FromShopify } from "@/components/advertising/FromShopify";
import { KeyInsights } from "@/components/advertising/Insights";
import { OverviewKpis } from "@/components/advertising/OverviewKpis";
import { PerformanceOverview, PlatformShare } from "@/components/advertising/PerformanceCharts";
import { PlatformCard, PlatformsVs } from "@/components/advertising/PlatformCards";
import { ProfitSummary } from "@/components/advertising/Profitability";
import { SalesBySite } from "@/components/advertising/SalesBySite";
import { fromShopifyOf } from "@/components/advertising/sources";
import { TopCampaigns } from "@/components/advertising/TopCampaigns";
import { useAdvertising } from "@/components/advertising/useAdvertising";
import { AdStatusNotes, AD_DEFINITIONS, Definitions } from "@/components/dashboard/AdsCommon";
import { plural } from "@/components/dashboard/format";

/**
 * Advertising Performance: every ad platform together, the owner's design. Spend, clicks, impressions,
 * the purchases and purchase value the platforms credit to their ads and ROAS at the top; then spend
 * against that value over the dates, how the spend splits, and the funnel from an ad shown to a purchase
 * in the store; Meta Ads and Google Ads a card each (from their own API, or the store's Shopify orders
 * while one isn't connected or its access ended, `ad_sources`); what stands out; the campaigns that spent
 * most, where the buyers came from and whether it made money; the two platforms side by side. With no
 * ad account at all, what the store's Shopify orders show of Meta and Google instead (FromShopify).
 */
export default function AdvertisingOverviewPage() {
  const { allowed } = useApp();
  const manage = allowed("integrations.manage");
  const s = useAdvertising();
  return (
    <>
      <AdvertisingHeader
        title="Advertising Performance"
        icon={<Megaphone aria-hidden className="h-5 w-5 text-accent" />}
        sub="Your Meta Ads and Google Ads together: what you spent, what the platforms credit to their ads, what reached your Shopify store, and whether it paid. AdSense's earnings are money in, kept apart from the spend."
        r={s.dates}
        shown={s.shown}
        current={!s.older}
        actions={
          <>
            {s.ov && <SyncedNow ov={s.ov} />}
            <DownloadCsv section="ads_summary" query={s.query} />
          </>
        }
      />
      <AdvertisingBody s={s} what="your advertising figures">
        {(ov) => {
          const a = ov.modules.ads;
          if (!a && !ov.modules.adsense) {
            return (
              <>
                <NotConnected ov={ov} compact={!!ov.modules.ads_from_shopify} />
                <FromShopify ov={ov} platforms={fromShopifyOf(ov)} />
              </>
            );
          }
          const accounts = [...(a?.accounts ?? []), ...(ov.modules.adsense?.accounts ?? [])];
          const left = accounts.filter((acc) => !acc.counted);
          return (
            <>
              <AdStatusNotes accounts={accounts} manage={manage} />
              <OverviewKpis ov={ov} />
              {a && (
                <>
                  <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
                    <div className="lg:col-span-2 2xl:col-span-1">
                      <PerformanceOverview a={a} ov={ov} />
                    </div>
                    <PlatformShare a={a} />
                    <AdFunnel ov={ov} />
                  </div>
                </>
              )}
              <div className="grid gap-4 xl:grid-cols-3">
                <PlatformCard ov={ov} provider="meta" manage={manage} />
                <PlatformCard ov={ov} provider="google" manage={manage} />
                {a ? <KeyInsights a={a} ov={ov} /> : <SalesBySite ov={ov} />}
              </div>
              {a && (
                <>
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
                    {a.campaigns ? <TopCampaigns a={a} /> : <PlatformsVs a={a} />}
                    <SalesBySite ov={ov} />
                    <ProfitSummary ov={ov} />
                  </div>
                  {a.campaigns && <PlatformsVs a={a} />}
                </>
              )}
              {left.length > 0 && (
                <p className="text-xs text-muted">
                  Left out of these figures: {left.map((acc) => `${acc.name ?? acc.accountId} (${acc.currency ?? "currency not known yet"})`).join(", ")}, because{" "}
                  {left.length === 1 ? "it's" : "they're"} in another currency. Amounts in different currencies are never added together.
                </p>
              )}
              {a && <MeasuresDiffer />}
              {a && <Definitions items={AD_DEFINITIONS} title="What the ad figures mean" />}
              <p className="text-xs text-muted">{plural(accounts.length, "account")} connected · updated about every hour, the last 30 days again daily.</p>
            </>
          );
        }}
      </AdvertisingBody>
    </>
  );
}

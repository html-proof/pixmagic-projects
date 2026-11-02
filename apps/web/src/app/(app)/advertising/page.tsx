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
import { ShopifyMarketingCard } from "@/components/advertising/ShopifyMarketing";
import { adSourcesOf, fromShopifyOf } from "@/components/advertising/sources";
import { TopCampaigns } from "@/components/advertising/TopCampaigns";
import { useAdvertising } from "@/components/advertising/useAdvertising";
import { AdStatusNotes, AD_DEFINITIONS, Definitions } from "@/components/dashboard/AdsCommon";
import { plural } from "@/components/dashboard/format";
import { leftOutOf } from "@/components/dashboard/profitFigures";

/**
 * Advertising Performance: every ad platform together, the owner's design. Spend, clicks, impressions,
 * the purchases and purchase value the platforms credit to their ads and ROAS at the top (each
 * platform's own with Meta and Google both counted: their claims can overlap); then spend
 * against that value over the dates, how the spend splits, and the funnel from an ad shown to a purchase
 * in the store; Meta Ads and Google Ads a card each (from their own API, or the store's Shopify orders
 * while one isn't connected or its access ended, `ad_sources`); what stands out; the campaigns that spent
 * most, where the buyers came from and whether it made money; the two platforms side by side. Beside
 * them, what the store's marketing apps report to Shopify (ShopifyMarketingCard). With no ad account at
 * all, that report first, Meta and Google from it, and what the store's Shopify orders show of them (FromShopify).
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
              <div className="@container space-y-4">
                <NotConnected ov={ov} compact={!!ov.modules.ads_from_shopify || !!ov.modules.shopify_marketing} />
                <ShopifyMarketingCard ov={ov} />
                {adSourcesOf(ov).some((x) => x.marketing) && (
                  <div className="grid gap-4 @4xl:grid-cols-2">
                    <PlatformCard ov={ov} provider="meta" manage={manage} />
                    <PlatformCard ov={ov} provider="google" manage={manage} />
                  </div>
                )}
                <FromShopify ov={ov} platforms={fromShopifyOf(ov)} />
              </div>
            );
          }
          const accounts = [...(a?.accounts ?? []), ...(ov.modules.adsense?.accounts ?? [])];
          // In another currency, so in none of the figures (`leftOut`). Never the Google Ads demo: its figures are simulated, not spend left out.
          const left = [...(a ? leftOutOf(a) : []), ...(ov.modules.adsense?.accounts ?? []).filter((acc) => !acc.counted && !acc.demo)];
          return (
            <div className="@container space-y-4">
              <AdStatusNotes accounts={accounts} manage={manage} />
              <OverviewKpis ov={ov} />
              {a && (
                <>
                  <div className="grid gap-4 @4xl:grid-cols-2 @7xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
                    <div className="@4xl:col-span-2 @7xl:col-span-1">
                      <PerformanceOverview a={a} ov={ov} />
                    </div>
                    <PlatformShare a={a} />
                    <AdFunnel ov={ov} />
                  </div>
                </>
              )}
              <div className="grid gap-4 @4xl:grid-cols-2 @7xl:grid-cols-3">
                <PlatformCard ov={ov} provider="meta" manage={manage} />
                <PlatformCard ov={ov} provider="google" manage={manage} />
                <div className="@4xl:col-span-2 @7xl:col-span-1">{a ? <KeyInsights a={a} ov={ov} /> : <SalesBySite ov={ov} />}</div>
              </div>
              <ShopifyMarketingCard ov={ov} />
              {a && (
                <>
                  <div className="grid gap-4 @4xl:grid-cols-2 @7xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
                    <div className="@4xl:col-span-2 @7xl:col-span-1">{a.campaigns ? <TopCampaigns a={a} /> : <PlatformsVs a={a} />}</div>
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
            </div>
          );
        }}
      </AdvertisingBody>
    </>
  );
}

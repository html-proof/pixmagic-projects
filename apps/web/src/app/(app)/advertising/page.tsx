"use client";
import { useApp } from "@/components/AppContext";
import { AdvertisingBody, AdvertisingHeader, DownloadCsv, MeasuresDiffer, NotConnected } from "@/components/advertising/AdvertisingUi";
import { FromShopify } from "@/components/advertising/FromShopify";
import { OverviewKpis } from "@/components/advertising/OverviewKpis";
import { fromShopifyOf } from "@/components/advertising/sources";
import { useAdvertising } from "@/components/advertising/useAdvertising";
import { AdvertisingSection } from "@/components/dashboard/Advertising";
import { SalesVsSpend } from "@/components/dashboard/AdsPanel";

/**
 * Every ad platform together: spend, what the platforms credit to their ads, the store's own sales per
 * unit of spend, and AdSense apart. A spend platform not connected, or whose access ended before these
 * dates were read, shows what the store's Shopify orders record of it instead (FromShopify, by
 * `ad_sources`), so the page is never empty while the store sells.
 */
export default function AdvertisingOverviewPage() {
  const { allowed } = useApp();
  const s = useAdvertising();
  return (
    <>
      <AdvertisingHeader
        title="Advertising"
        sub="Every platform together: what you spent, what the platforms credit to their ads, and your Shopify sales per unit of spend. AdSense's earnings are money in, kept apart from the spend."
        r={s.dates}
        shown={s.shown}
        current={!s.older}
        actions={<DownloadCsv section="ads_summary" query={s.query} />}
      />
      <AdvertisingBody s={s} what="your advertising figures">
        {(ov) =>
          !ov.modules.ads && !ov.modules.adsense ? (
            <>
              <NotConnected ov={ov} compact={!!ov.modules.ads_from_shopify} />
              <FromShopify ov={ov} platforms={fromShopifyOf(ov)} />
            </>
          ) : (
            <>
              <OverviewKpis ov={ov} />
              {ov.modules.ads && <SalesVsSpend a={ov.modules.ads} ov={ov} />}
              <AdvertisingSection ov={ov} manage={allowed("integrations.manage")} embedded />
              {ov.modules.ads && <MeasuresDiffer />}
              <FromShopify ov={ov} platforms={fromShopifyOf(ov)} sold />
            </>
          )
        }
      </AdvertisingBody>
    </>
  );
}

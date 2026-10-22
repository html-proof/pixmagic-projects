"use client";
import { useApp } from "@/components/AppContext";
import { AdvertisingBody, AdvertisingHeader, DownloadCsv, NotConnected } from "@/components/advertising/AdvertisingUi";
import { OverviewKpis } from "@/components/advertising/OverviewKpis";
import { useAdvertising } from "@/components/advertising/useAdvertising";
import { AdvertisingSection } from "@/components/dashboard/Advertising";
import { SalesVsSpend } from "@/components/dashboard/AdsPanel";

/** Every ad platform together: spend, what the platforms credit to their ads, the store's own sales per unit of spend, and AdSense apart. */
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
            <NotConnected ov={ov} />
          ) : (
            <>
              <OverviewKpis ov={ov} />
              {ov.modules.ads && <SalesVsSpend a={ov.modules.ads} ov={ov} />}
              <AdvertisingSection ov={ov} manage={allowed("integrations.manage")} embedded />
            </>
          )
        }
      </AdvertisingBody>
    </>
  );
}

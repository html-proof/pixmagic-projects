"use client";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { AdFunnel } from "@/components/advertising/AdFunnel";
import { AdvertisingBody, AdvertisingHeader } from "@/components/advertising/AdvertisingUi";
import { FromShopify } from "@/components/advertising/FromShopify";
import { SalesBySite } from "@/components/advertising/SalesBySite";
import { AttributionSummary } from "@/components/advertising/ShopifyAttribution";
import { useAdvertising } from "@/components/advertising/useAdvertising";
import { SalesVsSpend } from "@/components/dashboard/AdsPanel";

/**
 * Shopify attribution: what the store's own orders record of Meta and Google (the visit Shopify saw
 * before each order), whether or not their ad accounts are connected, next to what the platforms credit
 * to their ads. The visits from their sites through cart and checkout, the sales and orders by site and by
 * campaign, new and returning customers, refunds; never the platforms' claim added to the store's.
 */
export default function ShopifyAttributionPage() {
  const s = useAdvertising();
  return (
    <>
      <AdvertisingHeader
        title="Shopify attribution"
        icon={<ShopifyIcon size={20} />}
        sub="What your store recorded of Meta and Google: visits from their sites, carts, checkouts, orders and sales, by site and by campaign. It works without an ad account connected, and sits beside what each platform credits to its own ads."
        r={s.dates}
        shown={s.shown}
        current={!s.older}
      />
      <AdvertisingBody s={s} what="your Shopify attribution">
        {(ov) => (
          <>
            <AttributionSummary ov={ov} />
            <div className="grid gap-4 xl:grid-cols-2">
              <AdFunnel ov={ov} />
              <SalesBySite ov={ov} />
            </div>
            {ov.modules.ads && <SalesVsSpend a={ov.modules.ads} ov={ov} />}
            <FromShopify ov={ov} platforms={["meta", "google"]} />
          </>
        )}
      </AdvertisingBody>
    </>
  );
}

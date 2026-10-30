"use client";
import Link from "next/link";
import type { AdProvider } from "@app/shared/ads";
import { AdsDetail } from "@/components/dashboard/AdsPanel";
import { AdsenseDetail } from "@/components/dashboard/AdsensePanel";
import { Explained } from "@/components/dashboard/Explain";
import { AccountGone, AccountSelect, AdvertisingBody, AdvertisingHeader, DownloadCsv, NotConnected, PLATFORM } from "./AdvertisingUi";
import { useAccountChoices, useAdvertising } from "./useAdvertising";

// ---------------------------------------------------------------------------
// One platform's page in the Advertising area (Meta Ads, Google Ads, Google AdSense): the dashboard's
// details for that platform's accounts alone, or one of them. One platform's spend is never set
// against the store's whole sales here (the overview does that, for all of it); AdSense's earnings
// sit next to the store's sales as on the dashboard, except for one account picked.
// ---------------------------------------------------------------------------

const ABOUT: Record<AdProvider, string> = {
  meta: "What Meta charged for your Facebook and Instagram ads, and what Meta credits to them. Purchases are Meta's own count, not your Shopify orders.",
  google: "What Google charged for your ads, and what Google credits to them: purchases, and its other conversions (leads, sign-ups, calls) apart from them.",
  adsense:
    "What AdSense estimates the ads on your site earned: money in, never added to what you spend on ads. AdSense finalizes each month in the first days of the next: figures are marked Estimated until then, Final after.",
};

export function PlatformPage({ platform }: { platform: AdProvider }) {
  const s = useAdvertising(platform);
  const accounts = useAccountChoices([platform]);
  const P = PLATFORM[platform];
  return (
    <>
      <AdvertisingHeader
        title={P.name}
        icon={<P.Icon size={20} />}
        sub={ABOUT[platform]}
        r={s.dates}
        shown={s.shown}
        current={!s.older}
        actions={
          <>
            <AccountSelect accounts={accounts} value={s.account} onChange={s.setAccount} all={`All ${P.name} accounts`} />
            <DownloadCsv section={platform === "adsense" ? "adsense_daily" : "ads_daily"} query={s.query} label="Download by day" />
          </>
        }
      />
      {platform === "google" && (
        <div className="card flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="google-analytics-link">
          <span>
            <span className="font-medium">Account analytics</span>
            <span className="text-muted"> · one Google Ads account&apos;s campaigns, conversions, devices, audience and recommendations (the Google Ads demo&apos;s too)</span>
          </span>
          <Link className="text-xs text-accent underline" href="/advertising/google/analytics">
            Open account analytics
          </Link>
        </div>
      )}
      <AdvertisingBody s={s} what={`your ${P.name} figures`}>
        {(ov) =>
          s.account && !(platform === "adsense" ? ov.modules.adsense : ov.modules.ads) ? (
            <AccountGone onClear={() => s.setAccount(null)} />
          ) : platform === "adsense" ? (
            ov.modules.adsense ? (
              <>
                <AdsenseDetail ov={ov} />
                <Explained topic="adsense" ov={ov} currency={ov.modules.adsense.currency} />
              </>
            ) : (
              <NotConnected ov={ov} platform={platform} />
            )
          ) : ov.modules.ads ? (
            <>
              <AdsDetail ov={ov} />
              <Explained topic="ads" ov={ov} currency={ov.modules.ads.currency} />
            </>
          ) : (
            <NotConnected ov={ov} platform={platform} />
          )
        }
      </AdvertisingBody>
    </>
  );
}

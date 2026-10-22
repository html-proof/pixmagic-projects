"use client";
import type { AdSpendProvider } from "@app/shared/ads";
import { AccountGone, AccountSelect, AdvertisingBody, AdvertisingHeader, DownloadCsv, NotConnected, PLATFORM } from "@/components/advertising/AdvertisingUi";
import { CampaignComparison } from "@/components/advertising/CampaignComparison";
import { useAccountChoices, useAdvertising, useQueryParam } from "@/components/advertising/useAdvertising";

const isSpendPlatform = (v: string): v is AdSpendProvider => v === "meta" || v === "google";

/** Every Meta and Google Ads campaign side by side, from their stored days; by platform or account when one is picked. */
export default function CampaignComparisonPage() {
  const [platform, setPlatform] = useQueryParam("platform", isSpendPlatform);
  const s = useAdvertising(platform);
  const accounts = useAccountChoices(platform ? [platform] : ["meta", "google"]);
  return (
    <>
      <AdvertisingHeader
        title="Campaign comparison"
        sub="Every Meta Ads and Google Ads campaign of these dates side by side, on the measures that mean the same thing on both."
        r={s.dates}
        shown={s.shown}
        current={!s.older}
        actions={
          <>
            <label className="flex items-center gap-2 text-xs text-muted">
              Platform
              <select
                className="input h-9 w-auto py-0 text-sm"
                aria-label="Platform"
                value={platform ?? ""}
                onChange={(e) => {
                  setPlatform(isSpendPlatform(e.target.value) ? e.target.value : null);
                  s.setAccount(null);
                }}
                data-testid="campaign-platform"
              >
                <option value="">Meta Ads and Google Ads</option>
                <option value="meta">{PLATFORM.meta.name}</option>
                <option value="google">{PLATFORM.google.name}</option>
              </select>
            </label>
            <AccountSelect accounts={accounts} value={s.account} onChange={s.setAccount} />
            <DownloadCsv section="ads_campaigns" query={s.query} />
          </>
        }
      />
      <AdvertisingBody s={s} what="your campaigns">
        {(ov) =>
          s.account && !ov.modules.ads ? (
            <AccountGone onClear={() => s.setAccount(null)} />
          ) : !ov.modules.ads ? (
            <NotConnected ov={ov} platform={platform ?? undefined} />
          ) : !ov.modules.ads.campaigns ? (
            <p className="card text-sm text-muted">Campaign figures need the &ldquo;View campaigns&rdquo; permission.</p>
          ) : (
            <CampaignComparison ov={ov} />
          )
        }
      </AdvertisingBody>
    </>
  );
}

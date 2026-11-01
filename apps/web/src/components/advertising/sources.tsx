"use client";
import type { AdSpendProvider } from "@app/shared/ads";
import type { AdDataSource, AdPlatformSource } from "@app/shared/adsFromShopify";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import type { Overview } from "@/components/dashboard/types";
import { PLATFORM } from "./AdvertisingUi";

// ---------------------------------------------------------------------------
// Where Meta's and Google's figures come from (the API's `ad_sources`, adPlatformSources in
// packages/shared/src/adsFromShopify.ts), and the badge that says so beside them: the platform's own
// API, or the store's Shopify orders. Platform figures and Shopify-attributed sales never share a badge.
// ---------------------------------------------------------------------------

/**
 * Each spend platform's source (`only`: that one). An answer from before `ad_sources` existed: a
 * platform with ad accounts on the dashboard is its own, the others the orders when they came along.
 */
export function adSourcesOf(ov: Overview, only?: AdSpendProvider): AdPlatformSource[] {
  const given = ov.modules.ad_sources;
  if (given) return only ? given.filter((s) => s.provider === only) : given;
  return (only ? [only] : (["meta", "google"] as const)).map((provider) => {
    const own = !!ov.modules.ads?.byProvider.some((x) => x.provider === provider && x.accounts.length > 0);
    return { provider, state: own ? "connected" : "not_connected", source: own ? "platform" : ov.modules.ads_from_shopify ? "shopify" : "none" };
  });
}

/** The spend platforms whose figures come from the store's orders. */
export const fromShopifyOf = (ov: Overview, only?: AdSpendProvider): AdSpendProvider[] => adSourcesOf(ov, only).filter((s) => s.source === "shopify").map((s) => s.provider);

/** The badge's words: the platform's API, or Shopify's attribution of orders to it. */
export const SOURCE_LABEL: Record<Exclude<AdDataSource, "none">, (p: AdSpendProvider) => string> = {
  platform: (p) => `${PLATFORM[p].name} API`,
  shopify: () => "Shopify attribution",
};

/** A small badge naming where the figures beside it come from. */
export function SourceBadge({ provider, source }: { provider: AdSpendProvider; source: Exclude<AdDataSource, "none"> }) {
  const P = PLATFORM[provider];
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-border/60 px-2 py-0.5 text-[11px] font-medium text-muted" data-testid="ad-source-badge" data-source={source}>
      {source === "shopify" ? <ShopifyIcon size={12} /> : <P.Icon size={12} />}
      {SOURCE_LABEL[source](provider)}
    </span>
  );
}

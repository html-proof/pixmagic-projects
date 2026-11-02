import type { AdSpendProvider } from "@app/shared/ads";
import type { AdPlatformSource } from "@app/shared/adsFromShopify";
import type { ShopifyMarketing } from "@app/shared/shopifyMarketing";
import { shownFigures } from "@/components/dashboard/adFigures";
import { adsLeftOut, leftOutWords, type LeftOutAccount } from "@/components/dashboard/profitFigures";
import type { Overview } from "@/components/dashboard/types";

// ---------------------------------------------------------------------------
// "Total advertising expenses" on the Ad spend reported to Shopify card (ShopifyMarketing.tsx): every
// channel's spend for the dates, each from where it is shown, and what isn't in it, so a total that
// leaves a platform out says so. No React: test/marketingTotal.test.mjs runs it.
// ---------------------------------------------------------------------------

const NAME: Record<AdSpendProvider, string> = { meta: "Meta Ads", google: "Google Ads" };

/** One channel's spend in the total: from its own API, or what its app reported to Shopify; `through`: it covers the dates only up to that day so far. */
export type SpendPart = { key: string; name: string; spend: number; from: "platform" | "marketing"; through: string | null };

export interface TotalSpend {
  /** Every part added up, in the store's currency; null with no part. */
  total: number | null;
  parts: SpendPart[];
  /**
   * Platforms shown from their own API whose figures don't cover the dates yet (a first sync still
   * running, or syncs that stopped short of the dates): none of their spend is in `total`.
   */
  beingRead: Array<{ provider: AdSpendProvider; name: string }>;
  /** Ad accounts in another currency than the store's (`leftOut`, @/components/dashboard/profitFigures): none of their spend is in `total`. */
  otherCurrency: LeftOutAccount[];
  /** Something above is left out: `total` isn't every channel's spend. */
  partial: boolean;
}

/**
 * Every channel's spend for the dates (`sources`: adSourcesOf the answer). A platform whose source is
 * its own API counts its shown figures, in the store's currency only; one whose figures aren't in yet,
 * or whose accounts report in another currency, is left out and named (`beingRead`, `otherCurrency`),
 * never silently missing. The Google Ads demo is neither: its spend is simulated.
 */
export function totalSpend(ov: Overview, m: ShopifyMarketing, sources: readonly AdPlatformSource[]): TotalSpend {
  const parts: SpendPart[] = [];
  const beingRead: TotalSpend["beingRead"] = [];
  const otherCurrency: LeftOutAccount[] = [];
  const reportedThrough = m.through && m.through < ov.range.to ? m.through : null;
  const a = ov.modules.ads;
  for (const s of sources) {
    if (s.source === "platform") {
      const own = a?.byProvider.find((p) => p.provider === s.provider);
      if (own?.demo) continue;
      const shown = own ? shownFigures(own) : null;
      if (!a || !shown?.totals) {
        beingRead.push({ provider: s.provider, name: NAME[s.provider] });
        continue;
      }
      // Amounts in different currencies are never added together: those accounts are named instead.
      otherCurrency.push(...adsLeftOut(ov, m.currency).filter((acc) => acc.provider === s.provider));
      if (a.currency === m.currency) parts.push({ key: s.provider, name: NAME[s.provider], spend: shown.totals.spend, from: "platform", through: shown.through });
    } else if (s.marketing) {
      const spend = m.platforms.find((g) => g.platform === s.provider)?.totals?.spend;
      if (spend !== null && spend !== undefined) parts.push({ key: s.provider, name: NAME[s.provider], spend, from: "marketing", through: reportedThrough });
    }
  }
  for (const g of m.others) if (g.totals?.spend) parts.push({ key: `other:${g.name}`, name: g.name, spend: g.totals.spend, from: "marketing", through: reportedThrough });
  const total = parts.length ? Math.round(parts.reduce((n, p) => n + p.spend, 0) * 100) / 100 : null;
  return { total, parts, beingRead, otherCurrency, partial: beingRead.length > 0 || otherCurrency.length > 0 };
}

/**
 * Under the total, what isn't in it and why: "Left out: Meta Ads, its figures for these dates still
 * being read." and, for accounts in another currency, leftOutWords' "Left out: EU shop (EUR), in
 * another currency.". Empty when nothing is left out.
 */
export function totalLeftOutWords(t: Pick<TotalSpend, "beingRead" | "otherCurrency">): string[] {
  const words: string[] = [];
  if (t.beingRead.length) {
    const names = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(t.beingRead.map((p) => p.name));
    words.push(`Left out: ${names}, ${t.beingRead.length > 1 ? "their" : "its"} figures for these dates still being read.`);
  }
  const other = leftOutWords(t.otherCurrency);
  if (other) words.push(other);
  return words;
}

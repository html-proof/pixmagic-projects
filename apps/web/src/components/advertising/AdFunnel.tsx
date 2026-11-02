"use client";
import Link from "next/link";
import { useState } from "react";
import { Filter } from "lucide-react";
import type { AdSpendProvider } from "@app/shared/ads";
import type { AdJourney } from "@app/shared/adsFromShopify";
import { fmtNum, fmtPct } from "@/lib/api";
import { shownFigures } from "@/components/dashboard/adFigures";
import { fmtDay } from "@/components/dashboard/format";
import { ChartChoice } from "@/components/dashboard/Primitives";
import type { Overview } from "@/components/dashboard/types";
import { AdCard, EmptyNote } from "./AdCard";
import { PLATFORM } from "./AdvertisingUi";

// ---------------------------------------------------------------------------
// From an ad to a purchase, in two parts that are never divided into one another: what the platforms
// count (their ads shown, their links clicked), then what the storefront pixel saw of the visits that
// came from the platforms' sites (Facebook and Instagram, Google and YouTube), step by step: the same
// visits throughout, so each store step is a share of the one before. A click isn't always a visit and a
// visit from those sites isn't always from an ad (a post, a search result), so no rate joins the parts.
// ---------------------------------------------------------------------------

type Pick = "all" | AdSpendProvider;

interface Step {
  key: string;
  label: string;
  value: number | null;
  /** Of the step before, within its own part; null for a part's first step. */
  rate: number | null;
  color: string;
}

/** One colour per step (the app's chart tokens, light and dark): the platforms' steps, then the store's. */
const COLORS = ["var(--viz-cat-1)", "var(--viz-tier-1)", "var(--viz-cat-3)", "var(--viz-day-strong)", "var(--viz-cat-2)", "var(--viz-running)"];
/** The funnel's shape, widest first: drawn as a funnel, never to scale (the figures beside it are). */
const WIDTHS = [100, 86, 72, 60, 49, 40];

const rateOf = (n: number | null, of: number | null) => (n === null || of === null || of <= 0 ? null : n / of);

function addJourneys(js: Array<AdJourney | null | undefined>): AdJourney | null {
  const known = js.filter((j): j is AdJourney => !!j);
  if (!known.length) return null;
  return known.reduce((a, j) => ({
    visits: a.visits + j.visits,
    viewedProduct: a.viewedProduct + j.viewedProduct,
    addedToCart: a.addedToCart + j.addedToCart,
    startedCheckout: a.startedCheckout + j.startedCheckout,
    purchased: a.purchased + j.purchased,
  }));
}

export function AdFunnel({ ov }: { ov: Overview }) {
  const a = ov.modules.ads;
  const m = ov.modules.ads_from_shopify;
  const offered: Pick[] = ["all", ...((["meta", "google"] as const).filter((p) => a?.byProvider.some((x) => x.provider === p) || m?.platforms.some((x) => x.provider === p)))];
  const [picked, setPicked] = useState<Pick>("all");
  const on = offered.includes(picked) ? picked : "all";
  const fig = a ? (on === "all" ? a : a.byProvider.find((p) => p.provider === on)) : undefined;
  const ads = fig ? shownFigures(fig).totals : null;
  const platforms = m?.platforms.filter((p) => on === "all" || p.provider === on) ?? [];
  const journey = addJourneys(platforms.map((p) => p.journey));
  const sites = on === "all" ? "Facebook, Instagram, Google and YouTube" : on === "meta" ? "Facebook and Instagram" : "Google and YouTube";

  const adSteps: Step[] = ads
    ? [
        { key: "impressions", label: "Impressions", value: ads.impressions, rate: null, color: COLORS[0]! },
        { key: "clicks", label: "Link clicks", value: ads.linkClicks, rate: rateOf(ads.linkClicks, ads.impressions), color: COLORS[1]! },
      ]
    : [];
  const storeSteps: Step[] = journey
    ? [
        { key: "visits", label: "Store visits", value: journey.visits, rate: null, color: COLORS[2]! },
        { key: "cart", label: "Added to cart", value: journey.addedToCart, rate: rateOf(journey.addedToCart, journey.visits), color: COLORS[3]! },
        { key: "checkout", label: "Started checkout", value: journey.startedCheckout, rate: rateOf(journey.startedCheckout, journey.addedToCart), color: COLORS[4]! },
        { key: "purchased", label: "Purchased", value: journey.purchased, rate: rateOf(journey.purchased, journey.startedCheckout), color: COLORS[5]! },
      ]
    : [];
  const orders = platforms.reduce((n, p) => n + p.orders, 0);
  const since = m?.visitsFrom && m.visitsFrom > ov.range.from ? m.visitsFrom : null;

  return (
    <AdCard
      id="ads-funnel"
      title="Advertising funnel"
      sub="From an ad shown to a purchase in your store."
      icon={Filter}
      tint="blue"
      action={offered.length > 2 ? <ChartChoice<Pick> label="Funnel platform" value={on} onChange={setPicked} options={offered.map((p) => [p, p === "all" ? "All platforms" : PLATFORM[p].name])} /> : undefined}
    >
      {!adSteps.length && !storeSteps.length ? (
        <EmptyNote>No ad figures or tracked store visits for these dates yet.</EmptyNote>
      ) : (
        <div className="space-y-3">
          {adSteps.length > 0 && <Part title={on === "all" ? "In your ad platforms" : `In ${PLATFORM[on].name}`} steps={adSteps} offset={0} />}
          {storeSteps.length > 0 ? (
            <Part title={`In your store, from ${sites}${since ? ` since ${fmtDay(since, { year: false })}` : ""}`} steps={storeSteps} offset={adSteps.length} />
          ) : (
            <p className="rounded-lg bg-bg px-3 py-2 text-xs text-muted" data-testid="ads-funnel-no-store">
              {m && !m.platforms.some((p) => p.visits !== undefined)
                ? "Store visits, carts and checkouts need the bizinsights storefront pixel, or permission to see conversion rates."
                : "The storefront pixel hasn't recorded visits from these sites in these dates."}{" "}
              <Link href="/funnel" className="font-medium text-accent hover:underline">
                Shopping Funnel
              </Link>
            </p>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        Impressions and clicks are the platforms&apos; own count; the store steps are what the bizinsights pixel saw of visits from those sites (ads, posts and search results together), each a share of
        the step before. A click isn&apos;t always a visit, so no rate joins the two parts.
        {orders > 0 && ` Shopify records ${fmtNum(orders)} ${orders === 1 ? "order" : "orders"} whose last visit came from these sites.`}
      </p>
    </AdCard>
  );
}

function Part({ title, steps, offset }: { title: string; steps: Step[]; offset: number }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">{title}</p>
      <ol className="space-y-1.5">
        {steps.map((s, i) => (
          <li key={s.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-center gap-3" data-testid={`ads-funnel-${s.key}`}>
            <div className="flex justify-center" aria-hidden>
              <div className="h-7 rounded-md opacity-90" style={{ width: `${WIDTHS[offset + i] ?? 36}%`, background: s.color, clipPath: "polygon(0 0, 100% 0, 94% 100%, 6% 100%)" }} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs text-muted">{s.label}</p>
              <p className="text-sm font-semibold tabular-nums">
                {s.value === null ? "—" : fmtNum(s.value)}
                {s.rate !== null && <span className="ml-1.5 text-xs font-normal text-muted">({fmtPct(s.rate)})</span>}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

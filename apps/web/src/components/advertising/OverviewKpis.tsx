"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { BadgeDollarSign, Eye, Footprints, MousePointerClick, Percent, Receipt, ShoppingCart, Store, Target, Trophy, Wallet, type LucideIcon } from "lucide-react";
import { claimsAddUp, type AdsenseTotals, type AdSeriesDay, type AdTotals } from "@app/shared/ads";
import { trendPeriods } from "@app/shared/sales";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { BEING_READ, SoFarNote, UNAVAILABLE, UnavailableNote } from "@/components/dashboard/AdsCommon";
import { shownFigures } from "@/components/dashboard/adFigures";
import { DemoChip } from "@/components/dashboard/Advertising";
import { fmtDay, fmtMoneyWhole, fmtTimes, plural } from "@/components/dashboard/format";
import { sumDays, TileBars, tileTrend, tileTrendOf, type TileTrend } from "@/components/dashboard/TileBars";
import type { AdAccount, AdFigures, AdsModule, AdsProviderFigures, Overview } from "@/components/dashboard/types";
import { PLATFORM } from "./AdvertisingUi";

// ---------------------------------------------------------------------------
// The Advertising overview's headline figures (the owner's design: a tinted icon, the figure and a
// small bar chart of it over the dates, dashboard/TileBars.tsx): every spend platform together. The platforms' own counts
// are named as theirs; the store's own sales per unit of spend (MER) and its visits are Shopify's and the
// pixel's; AdSense's earnings are money in, on a tile of their own, never added to the spend. With more
// than one platform counted, their purchases are never added up (both can claim one order:
// `claimsAddUp`): each platform's own attributed revenue has a tile, beside the store's net sales.
// ---------------------------------------------------------------------------

const TINT = {
  blue: { disc: "bg-sky-600 dark:bg-sky-500", ink: "text-sky-600 dark:text-sky-400" },
  violet: { disc: "bg-violet-600 dark:bg-violet-500", ink: "text-violet-600 dark:text-violet-400" },
  green: { disc: "bg-emerald-600 dark:bg-emerald-500", ink: "text-emerald-600 dark:text-emerald-400" },
  amber: { disc: "bg-orange-500", ink: "text-orange-600 dark:text-orange-400" },
  teal: { disc: "bg-cyan-600 dark:bg-cyan-500", ink: "text-cyan-600 dark:text-cyan-400" },
  rose: { disc: "bg-rose-600 dark:bg-rose-500", ink: "text-rose-600 dark:text-rose-400" },
} as const;

function Tile({
  label,
  source,
  value,
  icon: IconCmp,
  tint,
  trend,
  small = false,
  children,
  testid,
}: {
  label: string;
  source: string;
  value: string;
  icon: LucideIcon;
  tint: keyof typeof TINT;
  /** The figure over the dates as a small bar chart (`tileTrendOf`); a day not read adds nothing. */
  trend?: TileTrend;
  small?: boolean;
  children?: ReactNode;
  testid: string;
}) {
  const t = TINT[tint];
  return (
    <div className={`card lift animate-rise flex min-w-0 flex-col ${small ? "p-3 sm:p-4" : ""}`} data-testid={testid}>
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden className={`shrink-0 items-center justify-center rounded-full text-white shadow-sm ${small ? "hidden h-8 w-8 @md:flex" : "flex h-10 w-10"} ${t.disc}`}>
          <IconCmp className={small ? "h-4 w-4" : "h-5 w-5"} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text/80">{label}</p>
          <p className={`truncate font-bold tabular-nums tracking-tight ${small ? "text-lg" : "text-xl sm:text-2xl"}`} data-testid={`${testid}-value`}>
            {value}
          </p>
        </div>
      </div>
      {/* The notes take the room there is, so the bars and the source line up along the row's foot. */}
      <div className="mt-2 min-w-0 flex-1 space-y-1 text-xs text-muted">{children}</div>
      {trend && <TileBars trend={trend} ink={t.ink} className="mt-2" />}
      <p className="mt-2 truncate text-[11px] uppercase tracking-wide text-muted" title={source}>
        {source}
      </p>
    </div>
  );
}

/**
 * One figure of an ad module: its value for the dates (or the days so far, dated; or Unavailable and
 * why).
 */
function FigureTile<T>({
  fig,
  accounts,
  ov,
  pick,
  extra,
  ...tile
}: Omit<Parameters<typeof Tile>[0], "value" | "children"> & {
  fig: AdFigures<T>;
  accounts: AdAccount[];
  ov: Overview;
  /** The figure, shown; null while some of its days are being read again, or it can't be worked out. */
  pick: (t: T) => string | null;
  /** A line more under the figure, from the same figures. */
  extra?: (t: T) => ReactNode;
}) {
  const { totals, through } = shownFigures(fig);
  if (!totals) {
    return (
      <Tile {...tile} value={UNAVAILABLE}>
        <UnavailableNote fig={fig} accounts={accounts} range={ov.range} show={(t) => pick(t) ?? BEING_READ} />
      </Tile>
    );
  }
  return (
    <Tile {...tile} value={pick(totals) ?? BEING_READ}>
      {through && <SoFarNote through={through} accounts={accounts} range={ov.range} />}
      {extra?.(totals)}
    </Tile>
  );
}

/**
 * ROAS over the days of one bar: the purchase value the platforms reported over what they spent,
 * never an average of the days' own ratios. Nothing spent, no figure.
 */
function roasOf(days: AdSeriesDay[]): number | null {
  const spend = sumDays(days, (d) => d.spend ?? 0);
  return spend > 0 ? sumDays(days, (d) => d.purchaseValue ?? 0) / spend : null;
}

export function OverviewKpis({ ov }: { ov: Overview }) {
  const a = ov.modules.ads;
  const sense = ov.modules.adsense;
  if (!a && !sense) return null;
  const counted = a?.accounts.filter((acc) => acc.counted) ?? [];
  const money = (n: number) => fmtMoney(n, a?.currency ?? ov.store.currency);
  const s = a?.sales ?? null;
  const series = a?.series ?? [];
  // A figure over the dates as bars: each adds up the days the platforms have it for.
  const bars = (pick: (d: AdSeriesDay) => number | null, format: (n: number) => string) =>
    tileTrendOf(series, ov.range, ov.today, (d) => pick(d) !== null, (days) => sumDays(days, (d) => pick(d) ?? 0), format);
  const visits = visitsFromAds(ov);
  // More than one platform counted: their purchases are each one's own claim, never added up.
  const apart = !!a && !claimsAddUp(a.byProvider.map((p) => p.provider));
  return (
    <section aria-label="Advertising at a glance" className="space-y-3">
      {a?.demo && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="ads-demo-note">
          <DemoChip /> The Google Ads demo&apos;s simulated figures are among these accounts, so they aren&apos;t set against your store&apos;s own sales.
        </p>
      )}
      {a && (
        <div className="grid grid-cols-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-3 @7xl:grid-cols-6">
          <FigureTile<AdTotals> label="Total ad spend" icon={Wallet} tint="blue" source={`All platforms · ${a.currency}`} fig={a} accounts={counted} ov={ov} pick={(t) => money(t.spend)} trend={bars((d) => d.spend, money)} testid="kpi-spend" />
          <FigureTile<AdTotals> label="Link clicks" icon={MousePointerClick} tint="violet" source="Platforms' own count" fig={a} accounts={counted} ov={ov} pick={(t) => (t.linkClicks === null ? null : fmtNum(t.linkClicks))} trend={bars((d) => d.linkClicks, fmtNum)} testid="kpi-clicks" />
          <FigureTile<AdTotals> label="Impressions" icon={Eye} tint="green" source="Platforms' own count" fig={a} accounts={counted} ov={ov} pick={(t) => fmtNum(t.impressions)} trend={bars((d) => d.impressions, fmtNum)} testid="kpi-impressions" />
          {apart ? (
            <>
              <NetSalesTile ov={ov} a={a} />
              {a.byProvider.map((p) => (
                <ClaimTile key={p.provider} a={a} p={p} ov={ov} />
              ))}
            </>
          ) : (
            <>
              <FigureTile<AdTotals> label="Purchases" icon={ShoppingCart} tint="amber" source="Platforms' own count" fig={a} accounts={counted} ov={ov} pick={(t) => (t.purchases === null ? null : fmtNum(t.purchases))} trend={bars((d) => d.purchases, fmtNum)} testid="kpi-purchases" />
              <FigureTile<AdTotals> label="Ad revenue (purchase value)" icon={BadgeDollarSign} tint="teal" source="Platforms' own count" fig={a} accounts={counted} ov={ov} pick={(t) => (t.purchaseValue === null ? null : money(t.purchaseValue))} trend={bars((d) => d.purchaseValue, money)} testid="kpi-purchase-value" />
              <FigureTile<AdTotals> label="ROAS" icon={Trophy} tint="violet" source="Purchase value ÷ spend · platforms' own" fig={a} accounts={counted} ov={ov} pick={(t) => (t.purchases === null ? null : fmtTimes(t.roas))} trend={tileTrendOf(series, ov.range, ov.today, (d) => d.spend !== null && d.purchaseValue !== null, roasOf, (n) => fmtTimes(n))} testid="kpi-roas" />
            </>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-3 @6xl:grid-cols-6">
        {a && (
          <>
            <FigureTile<AdTotals> small label="Average CPC" icon={Target} tint="blue" source="Spend ÷ link clicks" fig={a} accounts={counted} ov={ov} pick={(t) => (t.linkClicks === null ? null : t.cpc === null ? "—" : money(t.cpc))} testid="kpi-cpc" />
            <FigureTile<AdTotals> small label="CTR" icon={Percent} tint="violet" source="Link clicks ÷ impressions" fig={a} accounts={counted} ov={ov} pick={(t) => (t.linkClicks === null ? null : t.ctr === null ? "—" : fmtPct(t.ctr))} testid="kpi-ctr" />
            {/* Each platform's cost per purchase is on its own tile above when there are several. */}
            {!apart && <FigureTile<AdTotals> small label="Cost per purchase" icon={Receipt} tint="amber" source="Spend ÷ platforms' purchases" fig={a} accounts={counted} ov={ov} pick={(t) => (t.purchases === null ? null : t.costPerPurchase === null ? "—" : money(t.costPerPurchase))} testid="kpi-cost-per-purchase" />}
            <Tile small label={`Sales per ${fmtMoneyWhole(1, a.currency)} of ads (MER)`} icon={Store} tint="green" source="Shopify net sales ÷ ad spend" value={s ? fmtTimes(s.salesPerSpend) : UNAVAILABLE} testid="kpi-mer">
              {!s && <p>{a.demo ? "Not with the demo's simulated spend among the accounts." : "Needs every day of the spend, in your store's currency, and permission to see your sales."}</p>}
            </Tile>
          </>
        )}
        {visits && (
          <Tile small label="Store visits from ad sites" icon={Footprints} tint="teal" source="Your storefront pixel" value={fmtNum(visits.visits)} testid="kpi-visits">
            <p>
              From Facebook, Instagram, Google and YouTube{visits.since ? ` since ${fmtDay(visits.since, { year: false })}` : ""}: ads, posts and search together.
            </p>
          </Tile>
        )}
        {sense && (
          <FigureTile<AdsenseTotals>
            small
            label={sense.final ? "AdSense earnings (final)" : "AdSense estimated earnings"}
            icon={BadgeDollarSign}
            tint="rose"
            source={`Money in, not ad spend · ${sense.currency}`}
            fig={sense}
            accounts={sense.accounts.filter((acc) => acc.counted)}
            ov={ov}
            pick={(t) => fmtMoney(t.earnings, sense.currency)}
            testid="kpi-adsense"
          />
        )}
      </div>
      {a && apart && (
        <p className="text-xs text-muted" data-testid="ads-claims-apart">
          {a.byProvider.map((p) => PLATFORM[p.provider].name).join(" and ")} each credit purchases to their own ads, by their own rules, and can both claim the same order: these tiles
          show each one&apos;s purchases, attributed revenue and ROAS on its own, never added up. Your store&apos;s net sales, and its sales per {fmtMoneyWhole(1, a.currency)} of ads (MER), count every order once.
        </p>
      )}
      {sense && (
        <p className="text-xs text-muted print:hidden">
          AdSense is what ads shown on your site earn you: <Link href="/advertising/adsense" className="font-medium text-accent hover:underline">see AdSense</Link>.
        </p>
      )}
    </section>
  );
}

/**
 * Across platforms, the store's own sales for the dates (Shopify's net sales, in the store's currency):
 * every order once, whatever brought it, where the platforms' claims can count one twice. Never
 * beside the demo's simulated figures.
 */
function NetSalesTile({ ov, a }: { ov: Overview; a: AdsModule }) {
  const s = a.sales ?? null;
  const net = a.demo ? null : (s?.netSales ?? ov.modules.sales_overview?.current.netSales ?? null);
  const money = (n: number) => fmtMoney(n, ov.store.currency);
  const days = ov.modules.sales_overview?.series;
  return (
    <Tile
      label="Your store's net sales"
      icon={Store}
      tint="amber"
      source="Shopify · every order once"
      value={net === null ? UNAVAILABLE : money(net)}
      trend={net === null || !days ? undefined : tileTrend(trendPeriods(days, ov.range, ov.today, ov.data?.historyFrom ?? null), (ds) => sumDays(ds, (d) => d.netSales), money)}
      testid="kpi-net-sales"
    >
      {net === null ? (
        <p>{a.demo ? "Not with the demo's simulated spend among the accounts." : "Needs permission to see your sales."}</p>
      ) : (
        <p>Every order counted once, whatever brought it.</p>
      )}
    </Tile>
  );
}

/**
 * One platform's own attributed revenue (the purchase value it credits to its ads) with its purchases,
 * ROAS and cost per purchase: that platform's claim, named as its own, never added to another's.
 */
function ClaimTile({ a, p, ov }: { a: AdsModule; p: AdsProviderFigures; ov: Overview }) {
  const name = PLATFORM[p.provider].name;
  const money = (n: number) => fmtMoney(n, a.currency);
  const days = a.seriesByProvider.find((x) => x.provider === p.provider)?.series ?? [];
  return (
    <FigureTile<AdTotals>
      label={`${name} attributed revenue`}
      icon={BadgeDollarSign}
      tint={p.provider === "meta" ? "teal" : "violet"}
      source={`Claimed by ${name}`}
      fig={p}
      accounts={a.accounts.filter((acc) => acc.counted && acc.provider === p.provider)}
      ov={ov}
      pick={(t) => (t.purchaseValue === null ? null : money(t.purchaseValue))}
      trend={tileTrendOf(days, ov.range, ov.today, (d) => d.purchaseValue !== null, (ds) => sumDays(ds, (d) => d.purchaseValue ?? 0), money)}
      extra={(t) =>
        t.purchases !== null && (
          <p className="truncate" data-testid={`kpi-claim-${p.provider}-figures`}>
            {plural(t.purchases, "purchase")} · ROAS {fmtTimes(t.roas)}
            {t.costPerPurchase !== null ? ` · ${money(t.costPerPurchase)} a purchase` : ""}
          </p>
        )
      }
      testid={`kpi-claim-${p.provider}`}
    />
  );
}

/**
 * The storefront's visits from Meta's and Google's sites over the dates (the pixel's, `ads_from_shopify`),
 * and the day they're counted from when it's after the dates' first; null without them.
 */
export function visitsFromAds(ov: Overview): { visits: number; since: string | null } | null {
  const m = ov.modules.ads_from_shopify;
  const counted = m?.platforms.filter((p) => p.visits !== undefined && p.visits !== null) ?? [];
  if (!m || !counted.length) return null;
  return { visits: counted.reduce((n, p) => n + (p.visits ?? 0), 0), since: m.visitsFrom && m.visitsFrom > ov.range.from ? m.visitsFrom : null };
}

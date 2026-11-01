"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { BadgeDollarSign, Eye, Footprints, MousePointerClick, Percent, Receipt, ShoppingCart, Store, Target, Trophy, Wallet, type LucideIcon } from "lucide-react";
import type { AdsenseTotals, AdSeriesDay, AdTotals } from "@app/shared/ads";
import { delta } from "@app/shared/kpi";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { BEING_READ, ChangeNote, ComparedLine, SoFarNote, UNAVAILABLE, UnavailableNote } from "@/components/dashboard/AdsCommon";
import { shownFigures } from "@/components/dashboard/adFigures";
import { DemoChip } from "@/components/dashboard/Advertising";
import { fmtDay, fmtMoneyWhole, fmtSpan, fmtTimes } from "@/components/dashboard/format";
import { Sparkline } from "@/components/dashboard/HomeCards";
import { Delta } from "@/components/dashboard/Primitives";
import type { AdAccount, AdFigures, AdsModule, Overview } from "@/components/dashboard/types";

// ---------------------------------------------------------------------------
// The Advertising overview's headline figures (the owner's design: a tinted icon, the figure, its
// change and its shape over the days): every spend platform together, each figure with the one it is
// compared with and the change, on the days the API compared (an ad module's `compared`: whole days
// only, never against days an account hasn't stored); with no comparison, why. The platforms' own counts
// are named as theirs; the store's own sales per unit of spend (MER) and its visits are Shopify's and the
// pixel's; AdSense's earnings are money in, on a tile of their own, never added to the spend.
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
  spark,
  small = false,
  children,
  testid,
}: {
  label: string;
  source: string;
  value: string;
  icon: LucideIcon;
  tint: keyof typeof TINT;
  /** The figure day by day over the dates; a day not read is a gap. */
  spark?: Array<number | null>;
  small?: boolean;
  children?: ReactNode;
  testid: string;
}) {
  const t = TINT[tint];
  return (
    <div className={`card lift animate-rise flex min-w-0 flex-col rounded-2xl ${small ? "p-3 sm:p-4" : ""}`} data-testid={testid}>
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
      <div className="mt-2 flex min-w-0 flex-1 items-end justify-between gap-2">
        <div className="min-w-0 space-y-1 text-xs text-muted">{children}</div>
        {spark && <Sparkline values={spark} className={`hidden h-9 w-20 shrink-0 min-[420px]:block ${t.ink}`} />}
      </div>
      <p className="mt-2 truncate text-[11px] uppercase tracking-wide text-muted" title={source}>
        {source}
      </p>
    </div>
  );
}

/**
 * One figure of an ad module: its value for the dates (or the days so far, dated; or Unavailable and
 * why), its change, and what was compared.
 */
function FigureTile<T>({
  fig,
  accounts,
  ov,
  pick,
  delta: change,
  invert = false,
  neutral = false,
  ...tile
}: Omit<Parameters<typeof Tile>[0], "value" | "children"> & {
  fig: AdFigures<T>;
  accounts: AdAccount[];
  ov: Overview;
  /** The figure, shown; null while some of its days are being read again, or it can't be worked out. */
  pick: (t: T) => string | null;
  /** Its change, from the module's `deltas` (or the compared windows). */
  delta: number | null;
  invert?: boolean;
  neutral?: boolean;
}) {
  const { totals, through } = shownFigures(fig);
  if (!totals) {
    return (
      <Tile {...tile} value={UNAVAILABLE}>
        <UnavailableNote fig={fig} accounts={accounts} range={ov.range} show={(t) => pick(t) ?? BEING_READ} />
      </Tile>
    );
  }
  const shown = pick(totals);
  return (
    <Tile {...tile} value={shown ?? BEING_READ}>
      {through && <SoFarNote through={through} accounts={accounts} range={ov.range} />}
      {shown !== null && (
        <>
          <p>
            <ChangeNote fig={fig} value={change} ov={ov} invert={invert} neutral={neutral} />
          </p>
          {fig.compared && (
            <p data-testid={`${tile.testid}-compared`} className="truncate">
              <ComparedLine fig={fig} show={(t) => pick(t) ?? BEING_READ} />
            </p>
          )}
        </>
      )}
    </Tile>
  );
}

/** A rate's change on the compared windows (the module gives the counts' and money's changes only). */
const changeOn = (a: AdsModule, pick: (t: AdTotals) => number | null) => (a.compared ? delta(pick(a.compared.current.totals), pick(a.compared.previous.totals)) : null);

/** ROAS on each day the platforms spent and reported purchase value. */
const dailyRoas = (d: AdSeriesDay) => (d.spend && d.purchaseValue !== null ? d.purchaseValue / d.spend : null);

export function OverviewKpis({ ov }: { ov: Overview }) {
  const a = ov.modules.ads;
  const sense = ov.modules.adsense;
  if (!a && !sense) return null;
  const counted = a?.accounts.filter((acc) => acc.counted) ?? [];
  const money = (n: number) => fmtMoney(n, a?.currency ?? ov.store.currency);
  const s = a?.sales ?? null;
  const vs = s?.previous && a?.compared ? `vs ${fmtSpan(a.compared.previous.from, a.compared.previous.to)}` : null;
  const series = a?.series ?? [];
  const spark = (pick: (d: AdSeriesDay) => number | null) => series.map(pick);
  const visits = visitsFromAds(ov);
  return (
    <section aria-label="Advertising at a glance" className="space-y-3">
      {a?.demo && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="ads-demo-note">
          <DemoChip /> The Google Ads demo&apos;s simulated figures are among these accounts, so they aren&apos;t set against your store&apos;s own sales.
        </p>
      )}
      {a && (
        <div className="grid grid-cols-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-3 @7xl:grid-cols-6">
          <FigureTile<AdTotals> label="Total ad spend" icon={Wallet} tint="blue" source={`All platforms · ${a.currency}`} fig={a} accounts={counted} ov={ov} pick={(t) => money(t.spend)} delta={a.deltas.spend} neutral spark={spark((d) => d.spend)} testid="kpi-spend" />
          <FigureTile<AdTotals> label="Link clicks" icon={MousePointerClick} tint="violet" source="Platforms' own count" fig={a} accounts={counted} ov={ov} pick={(t) => (t.linkClicks === null ? null : fmtNum(t.linkClicks))} delta={a.deltas.linkClicks} spark={spark((d) => d.linkClicks)} testid="kpi-clicks" />
          <FigureTile<AdTotals> label="Impressions" icon={Eye} tint="green" source="Platforms' own count" fig={a} accounts={counted} ov={ov} pick={(t) => fmtNum(t.impressions)} delta={changeOn(a, (t) => t.impressions)} spark={spark((d) => d.impressions)} testid="kpi-impressions" />
          <FigureTile<AdTotals> label="Purchases" icon={ShoppingCart} tint="amber" source="Platforms' own count" fig={a} accounts={counted} ov={ov} pick={(t) => (t.purchases === null ? null : fmtNum(t.purchases))} delta={a.deltas.purchases} spark={spark((d) => d.purchases)} testid="kpi-purchases" />
          <FigureTile<AdTotals> label="Ad revenue (purchase value)" icon={BadgeDollarSign} tint="teal" source="Platforms' own count" fig={a} accounts={counted} ov={ov} pick={(t) => (t.purchaseValue === null ? null : money(t.purchaseValue))} delta={a.deltas.purchaseValue} spark={spark((d) => d.purchaseValue)} testid="kpi-purchase-value" />
          <FigureTile<AdTotals> label="ROAS" icon={Trophy} tint="violet" source="Purchase value ÷ spend · platforms' own" fig={a} accounts={counted} ov={ov} pick={(t) => (t.purchases === null ? null : fmtTimes(t.roas))} delta={a.deltas.roas} spark={spark(dailyRoas)} testid="kpi-roas" />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-3 @6xl:grid-cols-6">
        {a && (
          <>
            <FigureTile<AdTotals> small label="Average CPC" icon={Target} tint="blue" source="Spend ÷ link clicks" fig={a} accounts={counted} ov={ov} pick={(t) => (t.linkClicks === null ? null : t.cpc === null ? "—" : money(t.cpc))} delta={changeOn(a, (t) => t.cpc)} invert testid="kpi-cpc" />
            <FigureTile<AdTotals> small label="CTR" icon={Percent} tint="violet" source="Link clicks ÷ impressions" fig={a} accounts={counted} ov={ov} pick={(t) => (t.linkClicks === null ? null : t.ctr === null ? "—" : fmtPct(t.ctr))} delta={changeOn(a, (t) => t.ctr)} testid="kpi-ctr" />
            <FigureTile<AdTotals> small label="Cost per purchase" icon={Receipt} tint="amber" source="Spend ÷ platforms' purchases" fig={a} accounts={counted} ov={ov} pick={(t) => (t.purchases === null ? null : t.costPerPurchase === null ? "—" : money(t.costPerPurchase))} delta={changeOn(a, (t) => t.costPerPurchase)} invert testid="kpi-cost-per-purchase" />
            <Tile small label={`Sales per ${fmtMoneyWhole(1, a.currency)} of ads (MER)`} icon={Store} tint="green" source="Shopify net sales ÷ ad spend" value={s ? fmtTimes(s.salesPerSpend) : UNAVAILABLE} testid="kpi-mer">
              {s ? (
                vs ? (
                  <>
                    <p>
                      <Delta value={s.deltas.salesPerSpend} label={vs} />
                    </p>
                    <p>Before: {fmtTimes(s.previous!.salesPerSpend)}</p>
                  </>
                ) : (
                  <p>Changes show once the dates picked are over, with your orders imported for the dates compared.</p>
                )
              ) : (
                <p>{a.demo ? "Not with the demo's simulated spend among the accounts." : "Needs every day of the spend, in your store's currency, and permission to see your sales."}</p>
              )}
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
            delta={sense.deltas.earnings}
            testid="kpi-adsense"
          />
        )}
      </div>
      {sense && (
        <p className="text-xs text-muted print:hidden">
          AdSense is what ads shown on your site earn you: <Link href="/advertising/adsense" className="font-medium text-accent hover:underline">see AdSense</Link>.
        </p>
      )}
    </section>
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

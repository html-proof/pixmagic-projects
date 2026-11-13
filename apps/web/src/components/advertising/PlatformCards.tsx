"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { Check, Scale } from "lucide-react";
import type { AdSpendProvider, AdTotals } from "@app/shared/ads";
import type { AdConnectionState } from "@app/shared/adsFromShopify";
import { GoogleAdsIcon, MetaIcon } from "@/components/BrandIcons";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { BEING_READ, timeZoneNote, UNAVAILABLE } from "@/components/dashboard/AdsCommon";
import { shownFigures, upToWords } from "@/components/dashboard/adFigures";
import { DemoChip } from "@/components/dashboard/Advertising";
import { fmtRelative, fmtTimes, plural } from "@/components/dashboard/format";
import type { AdsModule, AdsProviderFigures, Overview } from "@/components/dashboard/types";
import { AdCard, CardLink, EmptyNote, MiniFigure } from "./AdCard";
import { PLATFORM_COLOR } from "./AdvertisingUi";
import { MarketingPlatformFigures } from "./ShopifyMarketing";
import { adSourcesOf, SourceBadge } from "./sources";

// ---------------------------------------------------------------------------
// Meta Ads and Google Ads on the Advertising overview, a card each, from wherever the platform's figures
// come from (`ad_sources`): its own API once an account is connected (spend, impressions, clicks and the
// purchases it credits to its ads, with what Shopify credits beside them); before that or once its access
// has ended, what its app reports to Shopify (`marketing`: spend, impressions, clicks, by the channel's
// own count) or else the store's Shopify orders (never a spend, click or ROAS, which only the platform
// knows); or the way to connect it. Then the two side by side, with which does better on each measure.
// ---------------------------------------------------------------------------

const NAME: Record<AdSpendProvider, string> = { meta: "Meta Ads", google: "Google Ads" };
const SITES: Record<AdSpendProvider, string> = { meta: "Facebook and Instagram", google: "Google and YouTube" };
const LOGO: Record<AdSpendProvider, (p: { size?: number }) => ReactNode> = { meta: MetaIcon, google: GoogleAdsIcon };
/** A soft wash of the platform's colour behind its logo (the design's creative tile; ad images aren't read). */
const WASH: Record<AdSpendProvider, string> = {
  meta: "from-sky-100 via-indigo-100 to-violet-200 dark:from-sky-400/15 dark:via-indigo-400/15 dark:to-violet-400/25",
  google: "from-amber-50 via-emerald-50 to-sky-100 dark:from-amber-400/10 dark:via-emerald-400/10 dark:to-sky-400/20",
};

function StateChip({ state, source }: { state: AdConnectionState; source: "platform" | "shopify" | "none" }) {
  if (source === "platform" && state === "connected") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-good/12 px-2 py-0.5 text-[11px] font-medium text-good" data-testid="ads-card-state">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-good" />
        Connected
      </span>
    );
  }
  const words = state === "access_lost" ? "Access ended" : state === "waiting" ? "Waiting for an ad account" : state === "hidden" ? "Hidden" : "Not connected";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${state === "access_lost" ? "bg-warn/10 text-warn" : "bg-border/60 text-muted"}`} data-testid="ads-card-state">
      {words}
    </span>
  );
}

function ConnectLink({ manage, provider, state }: { manage: boolean; provider: AdSpendProvider; state: AdConnectionState }) {
  if (!manage) return <p className="text-xs text-muted">A workspace admin can connect it.</p>;
  const hidden = state === "hidden";
  return (
    <Link href={hidden ? "/settings/ads" : "/settings/integrations"} className="btn-primary h-9 w-fit text-xs">
      {hidden ? "Manage ad accounts" : `${state === "access_lost" ? "Reconnect" : "Connect"} ${NAME[provider]}`}
    </Link>
  );
}

/** The platform's own figures, from its connected accounts' stored days. */
function OwnFigures({ a, p, ov, manage, lost }: { a: AdsModule; p: AdsProviderFigures; ov: Overview; manage: boolean; lost: boolean }) {
  const { totals: t, through } = shownFigures(p);
  const money = (n: number) => fmtMoney(n, a.currency);
  const accounts = a.accounts.filter((acc) => acc.provider === p.provider && acc.counted);
  const sourced = p.demo ? undefined : a.sourced?.find((x) => x.provider === p.provider);
  const Logo = LOGO[p.provider];
  const known = (v: number | null, show: (n: number) => string) => (v === null ? BEING_READ : show(v));
  const figures: Array<[string, string, string]> = t
    ? [
        ["spend", "Spend", money(t.spend)],
        ["impressions", "Impressions", fmtNum(t.impressions)],
        ["clicks", "Link clicks", known(t.linkClicks, fmtNum)],
        ["ctr", "CTR", t.linkClicks === null ? BEING_READ : t.ctr === null ? "—" : fmtPct(t.ctr)],
        ["cpc", "CPC", t.linkClicks === null ? BEING_READ : t.cpc === null ? "—" : money(t.cpc)],
        ["purchases", "Purchases", known(t.purchases, fmtNum)],
        ["value", "Purchase value", known(t.purchaseValue, money)],
        ["roas", "ROAS", t.purchases === null ? BEING_READ : fmtTimes(t.roas)],
        ["cpp", "Cost per purchase", t.purchases === null ? BEING_READ : t.costPerPurchase === null ? "—" : money(t.costPerPurchase)],
      ]
    : [];
  const updated = p.updatedAt ? fmtRelative(p.updatedAt) : null;
  return (
    <>
      <div className="flex min-w-0 flex-col gap-4 @md:flex-row">
        <div className={`flex shrink-0 flex-col items-center justify-center gap-2 rounded-xl bg-gradient-to-br p-4 text-center @md:w-36 ${WASH[p.provider]}`}>
          <Logo size={34} />
          <p className="text-xs font-medium text-text/80">{plural(accounts.length, "account")}</p>
          <p className="line-clamp-2 text-[11px] text-muted">{accounts.map((acc) => acc.name ?? acc.accountId).join(", ")}</p>
        </div>
        {t ? (
          <dl className="grid min-w-0 flex-1 grid-cols-3 gap-x-3 gap-y-3">
            {figures.map(([k, label, value]) => (
              <MiniFigure key={k} label={label} value={value} testid={`ads-card-${p.provider}-${k}`} />
            ))}
          </dl>
        ) : (
          <EmptyNote>{UNAVAILABLE}: some days of these dates haven&apos;t been read from {NAME[p.provider]} yet.</EmptyNote>
        )}
      </div>
      {t && through && <p className="mt-3 text-xs text-muted">Figures {upToWords(through)}.</p>}
      {p.provider === "google" && t && <p className="mt-1 text-xs text-muted">Conversions, every conversion action: {fmtNum(t.conversions)}.</p>}
      {sourced && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted" data-testid={`ads-card-${p.provider}-sourced`}>
          <SourceBadge provider={p.provider} source="shopify" />
          {plural(sourced.orders, "order")} · {fmtMoney(sourced.sales, ov.store.currency)} from {SITES[p.provider]}&apos;s tagged ads
          {sourced.salesPerSpend !== null && <> · {fmtTimes(sourced.salesPerSpend)} the spend in sales</>}
        </p>
      )}
      {lost && (
        <p className="mt-2 text-xs text-warn">
          bizinsights&apos; access to {NAME[p.provider]} has ended: these are the days it reported before. {manage ? <ConnectLink manage provider={p.provider} state="access_lost" /> : "A workspace admin can reconnect it."}
        </p>
      )}
      <p className="mt-auto pt-3 text-xs text-muted" data-testid={`ads-card-${p.provider}-source`}>
        Source: {NAME[p.provider]} · {updated ? `updated ${updated}` : "not read yet"}
        {timeZoneNote(accounts) ? ` · ${timeZoneNote(accounts)}` : ""}
        {p.demo ? " · simulated figures from the Google Ads demo, not set against your store's sales" : ""}
      </p>
    </>
  );
}

/** The platform as the store's Shopify orders record it: no spend, clicks or ROAS. */
function ShopifyFigures({ ov, provider, state, manage }: { ov: Overview; provider: AdSpendProvider; state: AdConnectionState; manage: boolean }) {
  const m = ov.modules.ads_from_shopify;
  const p = m?.platforms.find((x) => x.provider === provider);
  if (!m || !p) return <NoFigures provider={provider} state={state} manage={manage} />;
  const money = (n: number) => fmtMoney(n, m.currency);
  const top = p.campaigns?.[0];
  const sold = p.orders !== 0 || p.sales !== 0;
  return (
    <>
      <p className="mb-3 flex items-center gap-1.5 text-xs text-muted">
        Source <SourceBadge provider={provider} source="shopify" />
      </p>
      {sold ? (
        <dl className="grid grid-cols-3 gap-x-3 gap-y-3">
          <MiniFigure label={`Sales from ${SITES[provider]}`} value={money(p.sales)} testid={`ads-card-${provider}-sales`} />
          <MiniFigure label="Orders" value={fmtNum(p.orders)} />
          <MiniFigure label="Share of your sales" value={fmtPct(p.share)} />
          {p.paidSales !== undefined && <MiniFigure label="From tagged ads" value={money(p.paidSales)} />}
          {p.visits !== undefined && p.visits !== null && <MiniFigure label="Store visits" value={fmtNum(p.visits)} />}
          {top && <MiniFigure label="Top campaign (utm)" value={top.campaign} />}
        </dl>
      ) : (
        <EmptyNote>No sales from {SITES[provider]} recorded in these dates.</EmptyNote>
      )}
      <p className="mt-3 text-xs text-muted">
        The visit Shopify recorded before each order (the last click). Spend, impressions, clicks and ROAS come only from {NAME[provider]} itself
        {state === "access_lost" ? ": its access has ended." : ": connect it to add them."}
      </p>
      <div className="mt-auto pt-3">
        <ConnectLink manage={manage} provider={provider} state={state} />
      </div>
    </>
  );
}

function NoFigures({ provider, state, manage }: { provider: AdSpendProvider; state: AdConnectionState; manage: boolean }) {
  const Logo = LOGO[provider];
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-4 py-6 text-center">
      <Logo size={26} />
      <p className="max-w-xs text-sm text-muted">
        {state === "access_lost" ? `bizinsights' access to ${NAME[provider]} has ended.` : `${NAME[provider]} isn't connected.`} Connect it to see what its ads cost and what they bring back.
      </p>
      <ConnectLink manage={manage} provider={provider} state={state} />
    </div>
  );
}

/** One platform's card: its figures from wherever they come from, said by its state and badge. */
export function PlatformCard({ ov, provider, manage }: { ov: Overview; provider: AdSpendProvider; manage: boolean }) {
  const src = adSourcesOf(ov, provider)[0] ?? { provider, source: "none" as const, state: "not_connected" as const };
  const a = ov.modules.ads;
  const p = a?.byProvider.find((x) => x.provider === provider);
  const Logo = LOGO[provider];
  return (
    <AdCard
      id={`ads-card-${provider}`}
      title={
        <>
          <Logo size={20} />
          {NAME[provider]}
          <StateChip state={src.state} source={src.source} />
          {p?.demo && <DemoChip />}
        </>
      }
      action={<CardLink href={`/advertising/${provider}`} testid={`ads-card-${provider}-details`} />}
    >
      <div className="flex min-w-0 flex-1 flex-col" data-source={src.source}>
        {src.source === "platform" && a && p ? (
          <OwnFigures a={a} p={p} ov={ov} manage={manage} lost={src.state === "access_lost"} />
        ) : src.source === "platform" ? (
          <EmptyNote>
            Your {NAME[provider]} accounts report in another currency than your other ad accounts, so they aren&apos;t added up here: see {NAME[provider]}.
          </EmptyNote>
        ) : src.marketing && ov.modules.shopify_marketing ? (
          <>
            <MarketingPlatformFigures ov={ov} provider={provider} />
            <div className="pt-3">
              <ConnectLink manage={manage} provider={provider} state={src.state} />
            </div>
          </>
        ) : src.source === "shopify" ? (
          <ShopifyFigures ov={ov} provider={provider} state={src.state} manage={manage} />
        ) : (
          <NoFigures provider={provider} state={src.state} manage={manage} />
        )}
      </div>
    </AdCard>
  );
}

// ---- Side by side ---------------------------------------------------------------------------------

type Better = "higher" | "lower" | null;
interface VsRow {
  key: string;
  label: string;
  pick: (t: AdTotals) => number | null;
  show: (n: number) => string;
  better: Better;
}

/**
 * Meta Ads and Google Ads on the measures both report, each from its own figures, with the one that does
 * better on each (a lower cost, a higher rate or return) marked. Spend, impressions and clicks are sizes,
 * not results: neither is better. Only while both platforms have figures for the dates.
 */
export function PlatformsVs({ a }: { a: AdsModule }) {
  const meta = a.byProvider.find((p) => p.provider === "meta");
  const google = a.byProvider.find((p) => p.provider === "google");
  const m = meta ? shownFigures(meta).totals : null;
  const g = google ? shownFigures(google).totals : null;
  if (!m || !g) return null;
  const through = shownFigures(meta!).through ?? shownFigures(google!).through;
  const money = (n: number) => fmtMoney(n, a.currency);
  const rows: VsRow[] = [
    { key: "spend", label: "Spend", pick: (t) => t.spend, show: money, better: null },
    { key: "impressions", label: "Impressions", pick: (t) => t.impressions, show: fmtNum, better: null },
    { key: "clicks", label: "Link clicks", pick: (t) => t.linkClicks, show: fmtNum, better: null },
    { key: "ctr", label: "Click-through rate", pick: (t) => t.ctr, show: fmtPct, better: "higher" },
    { key: "cpc", label: "Cost per click", pick: (t) => t.cpc, show: money, better: "lower" },
    { key: "cpm", label: "Cost per 1,000 impressions", pick: (t) => t.cpm, show: money, better: "lower" },
    { key: "purchases", label: "Purchases (platform's count)", pick: (t) => t.purchases, show: fmtNum, better: null },
    { key: "value", label: "Purchase value (platform's count)", pick: (t) => t.purchaseValue, show: money, better: null },
    { key: "roas", label: "ROAS (platform's own)", pick: (t) => (t.purchases ? t.roas : null), show: fmtTimes, better: "higher" },
    { key: "cpp", label: "Cost per purchase", pick: (t) => t.costPerPurchase, show: money, better: "lower" },
  ];
  const winner = (r: VsRow): AdSpendProvider | null => {
    const mv = r.pick(m);
    const gv = r.pick(g);
    if (!r.better || mv === null || gv === null || mv === gv) return null;
    return (r.better === "higher" ? mv > gv : mv < gv) ? "meta" : "google";
  };
  const wins = { meta: rows.filter((r) => winner(r) === "meta").length, google: rows.filter((r) => winner(r) === "google").length };
  const lead: AdSpendProvider | null = wins.meta === wins.google ? null : wins.meta > wins.google ? "meta" : "google";
  return (
    <AdCard
      id="ads-vs"
      title="Meta Ads vs Google Ads"
      sub="Each platform's own figures for these dates. The marked one does better on that measure; spend, impressions, clicks and purchases are sizes, so neither is marked."
      icon={Scale}
      tint="violet"
    >
      {lead && (
        <p className="mb-3 rounded-lg bg-good/10 px-3 py-2 text-sm text-good" data-testid="ads-vs-lead">
          {NAME[lead]} does better on {wins[lead]} of the {wins.meta + wins.google} measures where one is better, by each platform&apos;s own count.
        </p>
      )}
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="px-1 pb-2 font-normal">Measure</th>
              {(["meta", "google"] as const).map((p) => {
                const Logo = LOGO[p];
                return (
                  <th key={p} className="px-1 pb-2 text-right font-normal">
                    <span className="inline-flex items-center gap-1.5">
                      <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: PLATFORM_COLOR[p] }} />
                      <Logo size={14} />
                      {NAME[p]}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const w = winner(r);
              const values = { meta: r.pick(m), google: r.pick(g) };
              const max = Math.max(values.meta ?? 0, values.google ?? 0);
              return (
                <tr key={r.key} className="border-t border-border" data-testid={`ads-vs-${r.key}`} data-better={w ?? ""}>
                  <th scope="row" className="px-1 py-2 text-left font-normal text-muted">
                    {r.label}
                  </th>
                  {(["meta", "google"] as const).map((p) => {
                    const v = values[p];
                    return (
                      <td key={p} className="px-1 py-2 text-right">
                        <span className={`inline-flex items-center gap-1 tabular-nums ${w === p ? "font-semibold text-good" : ""}`}>
                          {w === p && <Check aria-label="better" className="h-3.5 w-3.5" strokeWidth={3} />}
                          {v === null ? "—" : r.show(v)}
                        </span>
                        <span aria-hidden className="mt-1 ml-auto block h-1 rounded-full bg-bg">
                          <span className="block h-1 rounded-full" style={{ width: `${v !== null && max > 0 ? (v / max) * 100 : 0}%`, background: PLATFORM_COLOR[p], marginLeft: "auto" }} />
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        Purchases and ROAS are each platform&apos;s own claim, under its own attribution (Meta&apos;s window per ad set, Google&apos;s conversion settings), so they can overlap and aren&apos;t your Shopify
        orders.{through ? ` Figures ${upToWords(through)}.` : ""}
      </p>
    </AdCard>
  );
}

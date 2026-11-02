"use client";
import type { ReactNode } from "react";
import type { AdSpendProvider } from "@app/shared/ads";
import type { AdsFromShopify, ShopifyAdPlatform } from "@app/shared/adsFromShopify";
import { BarRow } from "@/components/dashboard/Charts";
import { fmtDay, fmtMoneyCompact, fmtSpan, plural } from "@/components/dashboard/format";
import { LineChart } from "@/components/dashboard/LineChart";
import { Delta } from "@/components/dashboard/Primitives";
import type { Overview } from "@/components/dashboard/types";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { PLATFORM } from "./AdvertisingUi";
import { adSourcesOf, SourceBadge } from "./sources";

// ---------------------------------------------------------------------------
// Meta Ads and Google Ads as the store's own orders record them (the API's `ads_from_shopify`,
// packages/shared/src/adsFromShopify.ts): what the Advertising pages show of a spend platform with no
// ad account connected. Everything here is Shopify's: the orders whose last visit came from the
// platform's sites, and their net sales. Nothing of what was spent, shown or clicked, which only the
// platform knows once it is connected; and never what the platform would credit to its ads.
// ---------------------------------------------------------------------------

/** The sites each platform's visits come from, in words. */
const SITES: Record<AdSpendProvider, string> = { meta: "Facebook and Instagram", google: "Google and YouTube" };

const SALES = "var(--viz-cat-3)";
const TAGGED = "var(--viz-cat-2)";

function Tile({ label, value, children, testid }: { label: string; value: string; children?: ReactNode; testid: string }) {
  return (
    <div className="card lift min-w-0" data-testid={testid}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 truncate text-2xl font-semibold tabular-nums" data-testid={`${testid}-value`}>
        {value}
      </p>
      <div className="mt-1 space-y-1 text-xs text-muted">{children}</div>
    </div>
  );
}

function Platform({ p, m, ov }: { p: ShopifyAdPlatform; m: AdsFromShopify; ov: Overview }) {
  const P = PLATFORM[p.provider];
  const money = (n: number) => fmtMoney(n, m.currency);
  const vs = m.compared ? `vs ${fmtSpan(m.compared.from, m.compared.to)}` : undefined;
  const tagged = p.paidSales !== undefined;
  const none = p.orders === 0 && p.sales === 0;
  const known = p.daily.filter((d) => d.sales !== null);
  // The platform's own figures show too (Shopify attribution page): nothing to connect.
  const own = adSourcesOf(ov, p.provider)[0]?.source === "platform";
  return (
    <section className="card space-y-4" aria-labelledby={`shopify-${p.provider}-h`} data-testid={`shopify-ads-${p.provider}`}>
      <div className="flex flex-wrap items-start gap-3">
        <span aria-hidden className="mt-0.5">
          <P.Icon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`shopify-${p.provider}-h`} className="flex flex-wrap items-center gap-2 font-semibold">
            {P.name}
            <SourceBadge provider={p.provider} source="shopify" />
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Orders whose visit came from {SITES[p.provider]}, as Shopify recorded it, and their sales.{" "}
            {own ? (
              <>What {P.name} itself reports (spend, impressions, clicks and what it credits to its ads) is on its own page, never added to these.</>
            ) : (
              <>
                {adSourcesOf(ov, p.provider)[0]?.state === "access_lost" ? `bizinsights' access to ${P.name} has ended: reconnect it to bring back` : `Connect ${P.name} to add`} what you spent, the
                impressions and clicks, and what {p.provider === "meta" ? "Meta" : "Google"} credits to its ads.
              </>
            )}
          </p>
        </div>
      </div>

      {none ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted" data-testid={`shopify-ads-${p.provider}-none`}>
          No orders came from {SITES[p.provider]} in these dates, as far as Shopify recorded where each visit came from.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Tile label={`Sales from ${SITES[p.provider]}`} value={money(p.sales)} testid={`shopify-${p.provider}-sales`}>
              <p>
                <Delta value={p.deltas.sales} label={vs} />
              </p>
              {p.previous && <p>Before: {money(p.previous.sales)}</p>}
            </Tile>
            <Tile label="Orders" value={fmtNum(p.orders)} testid={`shopify-${p.provider}-orders`}>
              <p>
                <Delta value={p.deltas.orders} label={vs} />
              </p>
              {p.previous && <p>Before: {fmtNum(p.previous.orders)}</p>}
            </Tile>
            <Tile label="Share of your sales" value={fmtPct(p.share)} testid={`shopify-${p.provider}-share`}>
              <p>Of {money(m.storeSales)} in sales from every source.</p>
              {p.visits !== undefined && p.visits !== null && (
                <p data-testid={`shopify-${p.provider}-visits`}>
                  {plural(p.visits, "store visit")} from {SITES[p.provider]}
                  {m.visitsFrom && m.visitsFrom > ov.range.from ? ` since ${fmtDay(m.visitsFrom)}` : ""}, as your storefront pixel recorded them.
                </p>
              )}
            </Tile>
            {tagged && (
              <Tile label="From links tagged as ads" value={money(p.paidSales ?? 0)} testid={`shopify-${p.provider}-tagged`}>
                <p>{plural(p.paidOrders ?? 0, "order")} through a link with an ad tag (utm_medium cpc or paid, a Google click id).</p>
                {p.deltas.paidSales !== undefined && (
                  <p>
                    <Delta value={p.deltas.paidSales} label={vs} />
                  </p>
                )}
              </Tile>
            )}
          </div>

          {known.length > 0 && (
            <LineChart
              days={p.daily.map((d) => d.day)}
              series={[
                { key: "sales", label: `Sales from ${SITES[p.provider]}`, color: SALES, values: p.daily.map((d) => d.sales) },
                ...(tagged ? [{ key: "tagged", label: "From links tagged as ads", color: TAGGED, values: p.daily.map((d) => d.paidSales ?? null) }] : []),
              ]}
              today={ov.today}
              height={190}
              area
              label={`Sales from ${SITES[p.provider]} by day, from your Shopify orders`}
              format={money}
              fmtAxis={(v) => fmtMoneyCompact(v, m.currency)}
            />
          )}

          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="text-sm font-medium">By site</h3>
              <ul className="mt-3 space-y-4">
                {p.sources.map((s) => (
                  <BarRow
                    key={s.source}
                    label={s.label}
                    value={money(s.sales)}
                    fraction={p.sales > 0 ? Math.max(0, s.sales) / p.sales : 0}
                    sub={
                      <>
                        {plural(s.orders, "order")}
                        {s.paidSales !== undefined && s.paidSales !== 0 && <> · {money(s.paidSales)} from tagged ads</>}
                      </>
                    }
                  />
                ))}
              </ul>
            </div>
            {p.campaigns && (
              <div>
                <h3 className="text-sm font-medium">Campaigns</h3>
                <p className="text-xs text-muted">From the campaign name in your ad links (utm_campaign).</p>
                {p.campaigns.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">None of these orders came through a link naming a campaign.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-border text-sm" data-testid={`shopify-${p.provider}-campaigns`}>
                    {p.campaigns.map((c) => (
                      <li key={`${c.source}:${c.campaign}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                        <span className="min-w-0 truncate">
                          <span className="font-medium">{c.campaign}</span> <span className="text-xs text-muted">{c.label}</span>
                        </span>
                        <span className="tabular-nums">
                          {money(c.sales)} <span className="text-xs text-muted">· {plural(c.orders, "order")}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Each of `platforms` from the store's orders (absent from `m`: not asked for), with what the figures
 * are and what they aren't; `sold`: only the ones with orders or sales in the dates (beside platforms
 * that are connected). Null without the module (a member who doesn't see traffic sources, a store
 * without them) or with none of the platforms in it.
 */
export function FromShopify({ ov, platforms, sold = false }: { ov: Overview; platforms: readonly AdSpendProvider[]; sold?: boolean }) {
  const m = ov.modules.ads_from_shopify;
  const shown = m?.platforms.filter((p) => platforms.includes(p.provider) && (!sold || p.orders !== 0 || p.sales !== 0)) ?? [];
  if (!m || !shown.length) return null;
  return (
    <div className="space-y-4" data-testid="ads-from-shopify">
      {m.pending > 0 && (
        <p className="card text-xs text-muted">
          Reading from Shopify where {plural(m.pending, "order")} of these dates came from; {m.pending === 1 ? "it's" : "they're"} added here within a few minutes.
        </p>
      )}
      {shown.map((p) => (
        <Platform key={p.provider} p={p} m={m} ov={ov} />
      ))}
      <p className="card text-xs text-muted" data-testid="ads-from-shopify-about">
        <span className="font-medium text-text">How these are counted.</span> Each order counts for the site its last visit came from, as Shopify recorded it
        (the last click), and its sales are net sales: after discounts and returns, before tax and shipping. An ad whose links carry no tags counts as a visit
        from that site, not as an ad. Meta and Google count their own way, so once connected, what they credit to their ads won&apos;t match these.
        {!m.compared && " Changes show once your orders for the dates compared with are imported."}
      </p>
    </div>
  );
}

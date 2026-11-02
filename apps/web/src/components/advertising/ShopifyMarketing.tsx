"use client";
import type { AdSpendProvider } from "@app/shared/ads";
import type { MarketingFigures, MarketingGroup, ShopifyMarketing } from "@app/shared/shopifyMarketing";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { shownFigures } from "@/components/dashboard/adFigures";
import { fmtDay, fmtRelative, fmtSpan, fmtTimes } from "@/components/dashboard/format";
import { ChangeText } from "@/components/dashboard/HomeCards";
import type { Overview } from "@/components/dashboard/types";
import { AdCard, EmptyNote, MiniFigure } from "./AdCard";
import { PLATFORM } from "./AdvertisingUi";
import { adSourcesOf, SourceBadge } from "./sources";

// ---------------------------------------------------------------------------
// The ad spend, impressions and clicks the store's marketing apps report to Shopify (the API's
// `shopify_marketing`, @app/shared/shopifyMarketing): Meta's and Google's with nothing to connect but
// Shopify, and every other channel that reported spend. Each figure says where it comes from (the
// channel, through Shopify), its dates, currency and when it was last read; a figure a channel didn't
// report is "Data unavailable", never 0. A platform whose own API is connected shows its own figures
// instead (PlatformCards), and these are never added to them.
// ---------------------------------------------------------------------------

export const DATA_UNAVAILABLE = "Data unavailable";

const or = (v: number | null, show: (n: number) => string) => (v === null ? DATA_UNAVAILABLE : show(v));
const whole = (n: number) => fmtNum(Math.round(n));

/** A group's figures, as reported, with the rates worked out from them. */
export function MarketingFiguresGrid({ t, currency, testid }: { t: MarketingFigures; currency: string; testid: string }) {
  const money = (n: number) => fmtMoney(n, currency);
  const figures: Array<[string, string, string]> = [
    ["spend", "Spend", or(t.spend, money)],
    ["impressions", "Impressions", or(t.impressions, fmtNum)],
    ["clicks", "Clicks", or(t.clicks, fmtNum)],
    ["ctr", "CTR", or(t.ctr, fmtPct)],
    ["cpc", "CPC", or(t.cpc, money)],
    ["cpm", "CPM", or(t.cpm, money)],
    ["orders", "Orders (its count)", or(t.orders, whole)],
    ["sales", "Sales (its count)", or(t.sales, money)],
    ["roas", "ROAS", or(t.roas, (n) => fmtTimes(n))],
    ["cpa", "Cost per order", or(t.costPerOrder, money)],
    ["cac", "Cost per new customer", or(t.costPerNewCustomer, money)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-3 @sm:grid-cols-3 @2xl:grid-cols-4">
      {figures.map(([k, label, value]) => (
        <MiniFigure key={k} label={label} value={value} testid={`${testid}-${k}`} />
      ))}
    </dl>
  );
}

/** Where a group's figures come from: the channel and app, through Shopify, its dates, currency and last read. */
export function MarketingSource({ m, g, ov }: { m: ShopifyMarketing; g: MarketingGroup; ov: Overview }) {
  const updated = fmtRelative(m.sync.lastSyncedAt);
  return (
    <p className="text-xs text-muted" data-testid={`marketing-source-${g.platform === "other" ? g.name : g.platform}`}>
      Source: {g.apps.length ? g.apps.join(", ") : g.channels.join(", ") || g.name}, reported to Shopify · {readDays(m, ov)} · {m.currency} · {updated ? `updated ${updated}` : "not read yet"}
      {g.availability === "reported" ? "" : ` · ${availabilityWords(g)}`}
    </p>
  );
}

/** The days the reported figures are of: the dates, or the part of them read so far, said so. */
function readDays(m: ShopifyMarketing, ov: Overview): string {
  if (!m.from || !m.through) return "none of these dates read yet";
  const span = fmtSpan(m.from, m.through);
  return m.from > ov.range.from || m.through < ov.range.to ? `${span} (the days read so far of ${fmtSpan(ov.range.from, ov.range.to)})` : span;
}

function availabilityWords(g: MarketingGroup): string {
  if (g.availability === "reported") return "reported";
  if (g.availability === "no_spend") return g.lastDay ? `no spend reported for these dates (last report ${fmtDay(g.lastDay, { year: false })})` : "no spend reported for these dates";
  return "nothing reported to Shopify";
}

/**
 * A platform's card body (PlatformCards) while its figures are what its app reports to Shopify
 * (`ad_sources` marketing): the reported figures, then the store's orders from its sites when they're
 * read too, then the offer to connect it for its own report.
 */
export function MarketingPlatformFigures({ ov, provider }: { ov: Overview; provider: AdSpendProvider }) {
  const m = ov.modules.shopify_marketing;
  const g = m?.platforms.find((x) => x.platform === provider);
  if (!m || !g?.totals) return null;
  const orders = ov.modules.ads_from_shopify?.platforms.find((x) => x.provider === provider);
  return (
    <>
      <p className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        Source <SourceBadge provider={provider} source="marketing" />
      </p>
      <MarketingFiguresGrid t={g.totals} currency={m.currency} testid={`ads-card-${provider}-marketing`} />
      {g.previous && (
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            Spend <ChangeText value={g.deltas.spend} neutral />
          </span>
          <span className="inline-flex items-center gap-1">
            Clicks <ChangeText value={g.deltas.clicks} />
          </span>
          <span className="inline-flex items-center gap-1">
            ROAS <ChangeText value={g.deltas.roas} />
          </span>
        </p>
      )}
      {orders && (orders.orders !== 0 || orders.sales !== 0) && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted" data-testid={`ads-card-${provider}-sourced`}>
          <SourceBadge provider={provider} source="shopify" />
          {fmtNum(orders.orders)} orders · {fmtMoney(orders.sales, ov.store.currency)} of your store&apos;s sales came from {provider === "meta" ? "Facebook and Instagram" : "Google and YouTube"} (the last click)
        </p>
      )}
      <div className="mt-auto pt-3">
        <MarketingSource m={m} g={g} ov={ov} />
      </div>
    </>
  );
}

/**
 * One platform's page (Meta Ads, Google Ads) while its figures are what its app reports to Shopify:
 * the reported figures in a card of their own. Null otherwise (`ad_sources` says so).
 */
export function MarketingPlatformCard({ ov, provider }: { ov: Overview; provider: AdSpendProvider }) {
  if (!adSourcesOf(ov, provider)[0]?.marketing || !ov.modules.shopify_marketing) return null;
  const P = PLATFORM[provider];
  return (
    <AdCard
      id={`marketing-page-${provider}`}
      title={
        <>
          <P.Icon size={18} /> {P.name}, as reported to Shopify
        </>
      }
      sub={`What its app tells Shopify about your ${P.name} ads: the channel's own count, read without connecting ${P.name}.`}
    >
      <MarketingPlatformFigures ov={ov} provider={provider} />
    </AdCard>
  );
}

type SpendPart = { key: string; name: string; spend: number; from: "platform" | "marketing"; through: string | null };

/**
 * Every channel's spend for the dates, each from where it is shown: a platform's own API, or what its
 * app reported to Shopify; `through`: a part that covers the dates only up to that day so far.
 */
function totalSpend(ov: Overview, m: ShopifyMarketing): { total: number | null; parts: SpendPart[]; mixed: boolean } {
  const parts: SpendPart[] = [];
  const reportedThrough = m.through && m.through < ov.range.to ? m.through : null;
  const a = ov.modules.ads;
  let mixed = false;
  for (const s of adSourcesOf(ov)) {
    if (s.source === "platform") {
      const own = a?.byProvider.find((p) => p.provider === s.provider);
      const shown = own ? shownFigures(own) : null;
      if (!shown?.totals || own?.demo) continue;
      if (a!.currency !== m.currency) mixed = true;
      else parts.push({ key: s.provider, name: PLATFORM[s.provider].name, spend: shown.totals.spend, from: "platform", through: shown.through });
    } else if (s.marketing) {
      const spend = m.platforms.find((g) => g.platform === s.provider)?.totals?.spend;
      if (spend !== null && spend !== undefined) parts.push({ key: s.provider, name: PLATFORM[s.provider].name, spend, from: "marketing", through: reportedThrough });
    }
  }
  for (const g of m.others) if (g.totals?.spend) parts.push({ key: `other:${g.name}`, name: g.name, spend: g.totals.spend, from: "marketing", through: reportedThrough });
  const total = parts.length ? Math.round(parts.reduce((n, p) => n + p.spend, 0) * 100) / 100 : null;
  return { total, parts, mixed };
}

function StatusNote({ m }: { m: ShopifyMarketing }) {
  if (m.status === "ready") {
    if (m.sync.error === "failed") return <p className="text-xs text-warn">The last read of Shopify&apos;s marketing report didn&apos;t get through: these are the figures read before, and bizinsights tries again within a few hours.</p>;
    return null;
  }
  const words =
    m.status === "syncing"
      ? "Reading what your marketing apps report to Shopify for the first time: the figures show here within a few minutes."
      : m.status === "access_denied"
        ? "Shopify didn't share its marketing report with bizinsights: it needs your Shopify reports and Shopify's approval of protected customer data. bizinsights asks again every few hours."
        : m.status === "unsupported"
          ? "Shopify doesn't run its marketing report for this store (its plan or region)."
          : "Shopify's marketing report couldn't be read just now; bizinsights tries again every few hours.";
  return <EmptyNote testid="marketing-status">{words}</EmptyNote>;
}

/**
 * The Advertising overview's card of what the store's marketing apps report to Shopify: every channel's
 * spend together, Meta's and Google's (or a note that their own API's figures are shown instead), the
 * other channels, their campaigns, and Shopify's own sessions beside them. Absent without the module
 * (reports not granted, or a member who doesn't see ad figures); with the capability locked, what would
 * turn it on.
 */
export function ShopifyMarketingCard({ ov }: { ov: Overview }) {
  const m = ov.modules.shopify_marketing;
  const capability = ov.capabilities.find((c) => c.id === "shopify_marketing");
  if (!m) {
    if (!capability || capability.enabled) return null;
    const requestable = capability.reconnectableScopes.length === 0 && capability.missingScopes.length > 0 && capability.requestableScopes.length === capability.missingScopes.length;
    return (
      <AdCard id="shopify-marketing" title={<><ShopifyIcon size={18} /> Ad spend reported to Shopify</>} sub="Your marketing apps' own spend, impressions and clicks, without connecting each ad account.">
        <EmptyNote testid="marketing-locked">
          {requestable
            ? "This needs permission to read your Shopify reports. A workspace owner or admin can turn on “Ad spend reported to Shopify” under More insights you can unlock on the dashboard, and Shopify asks them to approve it."
            : "This needs access to your Shopify reports, which bizinsights is waiting on Shopify to approve."}
        </EmptyNote>
      </AdCard>
    );
  }
  const money = (n: number) => fmtMoney(n, m.currency);
  const sources = adSourcesOf(ov);
  const spend = totalSpend(ov, m);
  const shown = [...m.platforms.filter((g) => sources.find((s) => s.provider === g.platform)?.source !== "platform"), ...m.others];
  const campaigns = shown
    .flatMap((g) => g.campaigns.map((c) => ({ ...c, channel: g.name })))
    .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0) || (b.sales ?? 0) - (a.sales ?? 0))
    .slice(0, 10);
  const sessions = ov.modules.shopify_sessions;
  const s = sessions?.status === "ready" ? sessions.current : null;
  return (
    <AdCard
      id="shopify-marketing"
      title={
        <>
          <ShopifyIcon size={18} /> Ad spend reported to Shopify
        </>
      }
      sub="What your Facebook & Instagram, Google & YouTube and other marketing apps report to Shopify about their ads: nothing else to connect. Each figure is the channel's own count."
    >
      <StatusNote m={m} />
      {m.status === "ready" && (
        <div className="space-y-5">
          <div data-testid="marketing-total">
            <p className="text-xs text-muted">Total advertising expenses · {fmtSpan(ov.range.from, ov.range.to)}</p>
            <p className="text-2xl font-bold tabular-nums tracking-tight" data-testid="marketing-total-value">
              {spend.total === null ? DATA_UNAVAILABLE : money(spend.total)}
            </p>
            {spend.parts.length > 0 && (
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                {spend.parts.map((p) => (
                  <li key={p.key} data-testid={`marketing-total-${p.key}`} data-from={p.from}>
                    {p.name} {money(p.spend)}{" "}
                    <span className="opacity-80">
                      ({p.from === "platform" ? "its own API" : "reported to Shopify"}
                      {p.through ? `, up to ${fmtDay(p.through, { year: false })}` : ""})
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {spend.mixed && <p className="mt-1 text-xs text-muted">Ad accounts in another currency than your store&apos;s aren&apos;t added in: amounts in different currencies are never added together.</p>}
          </div>

          {m.platforms.map((g) => {
            const own = sources.find((x) => x.provider === g.platform)?.source === "platform";
            return (
              <div key={g.platform} className="space-y-2 border-t border-border pt-4" data-testid={`marketing-${g.platform}`} data-availability={g.availability}>
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  {(() => {
                    const Icon = PLATFORM[g.platform as AdSpendProvider].Icon;
                    return <Icon size={16} />;
                  })()}
                  {g.name}
                </h3>
                {own ? (
                  <p className="text-xs text-muted">Shown from {g.name}&apos; own API above: what its app reports to Shopify isn&apos;t added to it, so no spend is counted twice.</p>
                ) : g.totals ? (
                  <>
                    <MarketingFiguresGrid t={g.totals} currency={m.currency} testid={`marketing-${g.platform}`} />
                    <MarketingSource m={m} g={g} ov={ov} />
                  </>
                ) : (
                  <p className="text-sm text-muted" data-testid={`marketing-${g.platform}-unavailable`}>
                    {DATA_UNAVAILABLE}: no {g.platform === "meta" ? "Facebook & Instagram" : "Google & YouTube"} app reports {g.name}&apos; spend to Shopify for this store. Connect {g.name} for its own report.
                  </p>
                )}
              </div>
            );
          })}

          {m.others.length > 0 && (
            <div className="border-t border-border pt-4" data-testid="marketing-others">
              <h3 className="text-sm font-semibold">Other channels</h3>
              <div className="-mx-1 mt-2 overflow-x-auto">
                <table className="w-full min-w-[28rem] text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th className="px-1 pb-2 font-normal">Channel</th>
                      <th className="px-1 pb-2 text-right font-normal">Spend</th>
                      <th className="px-1 pb-2 text-right font-normal">Clicks</th>
                      <th className="px-1 pb-2 text-right font-normal">Sales (its count)</th>
                      <th className="px-1 pb-2 text-right font-normal">ROAS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.others.map((g) => (
                      <tr key={g.name} className="border-t border-border">
                        <td className="px-1 py-2">{g.name}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{or(g.totals?.spend ?? null, money)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{or(g.totals?.clicks ?? null, fmtNum)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{or(g.totals?.sales ?? null, money)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{or(g.totals?.roas ?? null, (n) => fmtTimes(n))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {campaigns.length > 0 && (
            <div className="border-t border-border pt-4" data-testid="marketing-campaigns">
              <h3 className="text-sm font-semibold">Campaigns, as reported to Shopify</h3>
              <div className="-mx-1 mt-2 overflow-x-auto">
                <table className="w-full min-w-[30rem] text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th className="px-1 pb-2 font-normal">Campaign</th>
                      <th className="px-1 pb-2 font-normal">Channel</th>
                      <th className="px-1 pb-2 text-right font-normal">Spend</th>
                      <th className="px-1 pb-2 text-right font-normal">Clicks</th>
                      <th className="px-1 pb-2 text-right font-normal">ROAS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((c) => (
                      <tr key={`${c.channel}|${c.campaign}`} className="border-t border-border">
                        <td className="max-w-[16rem] truncate px-1 py-2" title={c.campaign}>
                          {c.campaign}
                        </td>
                        <td className="px-1 py-2 text-muted">{c.channel}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{or(c.spend, money)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{or(c.clicks, fmtNum)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{or(c.roas, (n) => fmtTimes(n))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {s && (
            <div className="border-t border-border pt-4" data-testid="marketing-sessions">
              <h3 className="text-sm font-semibold">Your store, as Shopify Analytics counts it</h3>
              <dl className="mt-2 grid grid-cols-3 gap-x-3">
                <MiniFigure label="Sessions" value={fmtNum(s.sessions)} />
                <MiniFigure label="Visitors" value={fmtNum(s.visitors)} />
                <MiniFigure label="Conversion rate" value={fmtPct(s.conversionRate)} />
              </dl>
            </div>
          )}

          <p className="text-xs text-muted" data-testid="marketing-about">
            Read from Shopify&apos;s marketing report every 6 hours, the last 7 days again daily
            {m.sync.backfilled ? "" : ", and your earlier days a few months at a time"}. Shopify can take up to 24 hours to receive a channel&apos;s figures. Spend a channel
            didn&apos;t report shows as {DATA_UNAVAILABLE}, never 0; orders and sales here are each channel&apos;s own claim, not your Shopify orders.
          </p>
        </div>
      )}
    </AdCard>
  );
}

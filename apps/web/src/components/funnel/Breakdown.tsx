"use client";
import { useState } from "react";
import type { SegmentFunnel } from "@app/shared/funnel";
import { fmtDay } from "@/components/dashboard/format";
import type { FunnelPageModule, Overview } from "@/components/dashboard/types";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { filterable, FunnelSection, segmentLabel, type SegmentDimension } from "./FunnelUi";
import { STAGES } from "./stageGuide";

const TABS: Array<[SegmentDimension, string]> = [
  ["device", "Device"],
  ["country", "Country"],
  ["landing", "Landing page"],
  ["visitor", "New vs returning"],
  ["source", "Traffic source"],
];

const WHAT: Record<SegmentDimension, string> = {
  device: "The kind of device each visit came from, read from the browser's own description of itself.",
  country: "The country each visit came from, as our network placed it. No address is kept.",
  landing: "The part of your store each visit started on.",
  visitor: "Returning visits are browsers the pixel saw on an earlier day; a shopper on a new device, or who cleared their cookies, counts as new.",
  source:
    "Where each visit came from: the site that linked to your store and the link's tags, sorted by the same rules as your orders' sources below. A visit typed in, bookmarked or opened from an app without tags is Direct. A shopper who comes back from somewhere else the same day keeps the first source.",
};

/** Up to three segments' progression at each step, side by side: the device comparison. */
function ProgressionBars({ segments, dim }: { segments: SegmentFunnel[]; dim: SegmentDimension }) {
  const shown = segments.filter((s) => filterable(dim, s.key) && s.visits > 0).slice(0, 3);
  if (shown.length < 2) return null;
  const color = ["var(--viz-cat-1)", "var(--viz-cat-2)", "var(--viz-cat-3)"];
  const steps = ["viewed_product", "added_to_cart", "started_checkout", "purchased"] as const;
  return (
    <figure className="mt-5" aria-labelledby={`progression-${dim}`}>
      <figcaption id={`progression-${dim}`} className="text-sm font-medium">
        How often each {dim === "device" ? "device's" : "group's"} visits go on to the next step
      </figcaption>
      <p className="text-xs text-muted">Bar height: progression rate at each step, 0–100% (visits that went on ÷ visits at the step before). Hover or focus a bar for the visits behind it.</p>
      <div className="mt-2 flex flex-wrap gap-3 text-xs" aria-hidden>
        {shown.map((s, i) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color[i] }} />
            {segmentLabel(dim, s.key)}
          </span>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {steps.map((step, k) => (
          <div key={step} className="min-w-0">
            <div className="flex h-32 items-end gap-1.5 border-b border-border">
              {shown.map((s, i) => {
                const rate = s.progression[k];
                const label = `${segmentLabel(dim, s.key)}, ${STAGES[step].wentOn}: ${fmtPct(rate)} (${fmtNum(s.reached[k + 1])} of ${fmtNum(s.reached[k])} visits)`;
                return (
                  <span key={s.key} tabIndex={0} title={label} aria-label={label} className="group relative flex h-full flex-1 flex-col justify-end focus-visible:outline-none">
                    <span aria-hidden className="mb-0.5 text-center text-[10px] tabular-nums text-muted">{rate === null ? "–" : `${Math.round(rate * 100)}%`}</span>
                    <span className="block w-full rounded-t transition-opacity group-hover:opacity-80 group-focus-visible:ring-2 group-focus-visible:ring-accent" style={{ height: `${(rate ?? 0) * 85}%`, minHeight: rate ? 2 : 0, background: color[i] }} />
                  </span>
                );
              })}
            </div>
            <p className="mt-1 text-center text-xs text-muted">{STAGES[step].name}</p>
          </div>
        ))}
      </div>
    </figure>
  );
}

function SegmentTable({ dim, segments, onFilter, f }: { dim: SegmentDimension; segments: SegmentFunnel[]; onFilter: (dim: SegmentDimension, key: string) => void; f: FunnelPageModule }) {
  if (!segments.length) return <p className="text-sm text-muted">No visits in these dates.</p>;
  const top = Math.max(...segments.map((s) => s.conversionRate ?? 0), 0);
  const cell = (s: SegmentFunnel, k: number) => (
    <td className="px-2 py-2 text-right tabular-nums">
      {fmtPct(s.visits ? s.reached[k]! / s.visits : null)}
      <span className="block text-[11px] text-muted">{fmtNum(s.reached[k])}</span>
    </td>
  );
  return (
    <>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm" data-testid={`funnel-segments-${dim}`}>
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="px-2 pb-2 font-normal">{TABS.find(([t]) => t === dim)?.[1]}</th>
              <th className="px-2 pb-2 text-right font-normal">Visits</th>
              <th className="px-2 pb-2 text-right font-normal">Viewed a product</th>
              <th className="px-2 pb-2 text-right font-normal">Added to cart</th>
              <th className="px-2 pb-2 text-right font-normal">Started checkout</th>
              <th className="px-2 pb-2 text-right font-normal">Bought</th>
              <th className="px-2 pb-2 font-normal">Conversion rate</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s) => (
              <tr key={s.key} className="border-t border-border">
                <td className="px-2 py-2">
                  {filterable(dim, s.key) && !f.filter[dim] ? (
                    <button type="button" className="text-left font-medium underline decoration-border underline-offset-2 hover:decoration-text" onClick={() => onFilter(dim, s.key)} title="Show only these visits">
                      {segmentLabel(dim, s.key)}
                    </button>
                  ) : (
                    <span className="font-medium">{segmentLabel(dim, s.key)}</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{fmtNum(s.visits)}</td>
                {cell(s, 1)}
                {cell(s, 2)}
                {cell(s, 3)}
                {cell(s, 4)}
                <td className="px-2 py-2">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="h-1.5 w-20 rounded-full bg-bg">
                      <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${top > 0 ? ((s.conversionRate ?? 0) / top) * 100 : 0}%` }} />
                    </span>
                    <span className="tabular-nums">{fmtPct(s.conversionRate)}</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        Percentages are of each row&apos;s own visits; counts under them. Select a name to narrow the whole page to those visits.
        {segments.some((s) => s.key === "not_recorded") && (dim === "device" || dim === "country")
          ? ` "Not recorded" is visits from before devices and countries were recorded${f.detailsFrom ? ` (from ${fmtDay(f.detailsFrom, { year: true })})` : ""}.`
          : ""}
        {segments.some((s) => s.key === "not_recorded") && dim === "source"
          ? ` "Not recorded" is visits from before traffic sources were recorded${f.sourcesFrom ? ` (from ${fmtDay(f.sourcesFrom, { year: true })})` : ""}, and visits whose first tracked page wasn't the one they arrived on (tracking accepted on a later page).`
          : ""}
      </p>
    </>
  );
}

/** The store's orders by traffic source (Shopify's record of each order's last visit), beside the visits by source: never divided by them. */
function OrdersBySource({ ov }: { ov: Overview }) {
  const traffic = ov.modules.traffic;
  if (!traffic) return null;
  const currency = ov.store.currency;
  return (
    <div className="mt-6 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Orders by traffic source</h3>
      <p className="mb-3 text-xs text-muted">
        Where your orders&apos; shoppers came from, as Shopify recorded each order&apos;s last visit before buying: every order in these dates, tracked or not, so the filter above doesn&apos;t apply to it. A different measure from the visits above, so read the two side by side rather than as a rate.
      </p>
      {traffic.items.length === 0 ? (
        <p className="text-sm text-muted">No orders with a recorded source in these dates.</p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[30rem] text-sm" data-testid="funnel-orders-by-source">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-2 pb-2 font-normal">Source</th>
                <th className="px-2 pb-2 text-right font-normal">Orders</th>
                <th className="px-2 pb-2 text-right font-normal">Net sales</th>
                <th className="px-2 pb-2 font-normal">Share of sales</th>
              </tr>
            </thead>
            <tbody>
              {traffic.items.map((t) => (
                <tr key={t.id} className="border-t border-border">
                  <td className="px-2 py-2 font-medium">{t.label}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtNum(t.orders)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtMoney(t.sales, currency)}</td>
                  <td className="px-2 py-2">
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="h-1.5 w-20 rounded-full bg-bg">
                        <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${(t.share ?? 0) * 100}%` }} />
                      </span>
                      <span className="tabular-nums">{fmtPct(t.share)}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {traffic.pending > 0 && <p className="mt-2 text-xs text-muted">{fmtNum(traffic.pending)} orders&apos; sources haven&apos;t been read from Shopify yet.</p>}
    </div>
  );
}

/**
 * The funnel by segment: device, country, landing page, new or returning visitors and traffic
 * source (each a funnel of its own, on the same visits), with the store's orders by traffic source
 * beside the visits by source. Selecting a segment narrows the whole page to it.
 */
export function Breakdown({ f, ov, onFilter }: { f: FunnelPageModule; ov: Overview; onFilter: (dim: SegmentDimension, key: string) => void }) {
  const [tab, setTab] = useState<SegmentDimension>("device");
  // Where visitors came from is shown only to members who see traffic sources.
  const tabs = TABS.filter(([t]) => t !== "source" || f.segments.source);
  const segments = f.segments[tab] ?? [];
  // Visits by source weren't recorded in these dates (a pixel from before it sent them).
  const noSources = tab === "source" && !segments.some((s) => s.key !== "not_recorded");
  return (
    <FunnelSection id="breakdown" title="Funnel performance breakdown" sub="Compare how different kinds of visits move through the funnel, and which bring more completed purchases.">
      <div role="tablist" aria-label="Break the funnel down by" className="flex flex-wrap gap-1 rounded-xl border border-border bg-bg p-1" data-print-hide>
        {tabs.map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`breakdown-tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`breakdown-panel-${t}`}
            onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${tab === t ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-text"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`breakdown-panel-${tab}`} aria-labelledby={`breakdown-tab-${tab}`} className="mt-4">
        <p className="mb-3 text-sm text-muted">{WHAT[tab]}</p>
        {noSources && (
          <p className="mb-3 rounded-lg border border-border bg-bg p-3 text-sm text-muted" data-testid="funnel-sources-not-recorded">
            {f.sourcesFrom
              ? `Traffic sources are recorded from ${fmtDay(f.sourcesFrom, { year: true })}: the visits in these dates are from before.`
              : "Traffic sources are recorded once your store runs the updated bizinsights pixel. Until then visits show as \u201cNot recorded\u201d, and your orders by source are shown below."}
          </p>
        )}
        <SegmentTable dim={tab} segments={segments} onFilter={onFilter} f={f} />
        <ProgressionBars segments={segments} dim={tab} />
        {tab === "source" && <OrdersBySource ov={ov} />}
      </div>
    </FunnelSection>
  );
}

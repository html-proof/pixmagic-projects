"use client";
import type { FunnelStep, FunnelStepSummary, JourneyPageRow, SectionSummary, SiteSection } from "@app/shared/journey";
import { fmtNum, fmtPct } from "@/lib/api";
import { BarRow } from "./Charts";
import { noEarlierData } from "./DateRange";
import { plural } from "./format";
import { AnimatedNumber } from "./Motion";
import { Badge, Delta, Empty, Panel, Stat } from "./Primitives";
import type { FunnelModule } from "./types";

export const STEP_LABEL: Record<FunnelStep, string> = {
  visited: "Visited your store",
  viewed_product: "Viewed a product",
  added_to_cart: "Added to cart",
  started_checkout: "Started checkout",
  purchased: "Completed a purchase",
};

/** What getting past each step means, for the line under it. */
const WENT_ON: Record<FunnelStep, string> = {
  visited: "went on to view a product",
  viewed_product: "went on to add to cart",
  added_to_cart: "went on to start checkout",
  started_checkout: "went on to complete their purchase",
  purchased: "",
};

export const SECTION_LABEL: Record<SiteSection, string> = {
  home: "Home page",
  collection: "Collection pages",
  product: "Product pages",
  search: "Search",
  cart: "Cart",
  checkout: "Checkout",
  content: "Pages & blog",
  account: "Customer account",
  other: "Other pages",
};
const sectionName = (s: SiteSection | null) => (s ? SECTION_LABEL[s] : "Page not recorded");

/** Paths the ingest collapses to one fixed page get a plain name; the rest are shown as the address. */
const FIXED_PAGES: Record<string, string> = {
  "/": "Home page",
  "/checkout": "Checkout",
  "/cart": "Cart",
  "/search": "Search results",
  "/account": "Customer account",
};

/** "Product pages · …" under an address; nothing to add under a page that already has a plain name. */
const sectionPrefix = (p: JourneyPageRow) => (FIXED_PAGES[p.path] ? "" : `${SECTION_LABEL[p.section]} · `);

function PageName({ path }: { path: string }) {
  const name = FIXED_PAGES[path];
  return name ? <span>{name}</span> : <span className="font-mono text-xs">{path}</span>;
}

/** How many sections to name under a step before folding the rest into "+N more". */
const LEFT_FROM_SHOWN = 4;

function StepRow({ s, index, visits, last }: { s: FunnelStepSummary; index: number; visits: number; last: boolean }) {
  const width = visits > 0 ? (s.reached / visits) * 100 : 0;
  // Inside this step's bar: the part that went on (solid) and the part that left here (tinted).
  const wentOn = last ? 100 : s.reached > 0 ? ((s.continued ?? 0) / s.reached) * 100 : 0;
  const shown = s.leftFrom.slice(0, LEFT_FROM_SHOWN);
  const hidden = s.leftFrom.slice(LEFT_FROM_SHOWN).reduce((a, x) => a + x.visits, 0);
  return (
    <li className="animate-rise relative pl-9" style={{ ["--i" as string]: index + 2 }} data-testid={`funnel-step-${s.step}`}>
      {!last && <span aria-hidden className="absolute bottom-0 left-[11px] top-7 w-px bg-border" />}
      <span aria-hidden className={`absolute left-0 top-0 flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${last ? "bg-accent text-accent-ink" : "border border-border bg-bg"}`}>
        {index + 1}
      </span>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-medium">{STEP_LABEL[s.step]}</span>
        <span className="text-sm">
          <strong className="tabular-nums"><AnimatedNumber value={s.reached} format={fmtNum} /></strong>
          <span className="text-muted"> · {fmtPct(s.shareOfVisits)} of visits</span>
        </span>
      </div>
      <div className="mt-2 h-3 rounded-full bg-bg">
        <div className="animate-grow-x flex h-3 gap-[2px] overflow-hidden rounded-full transition-[width] duration-700" style={{ width: `${width}%`, minWidth: s.reached > 0 ? 6 : 0, ["--i" as string]: index }}>
          {wentOn > 0 && <div className="bg-gradient-to-r from-accent to-accent/80" style={{ width: `${wentOn}%` }} />}
          {!last && s.left > 0 && <div className="flex-1 bg-danger/30" />}
        </div>
      </div>
      {!last && (
        <div className="space-y-1 pb-5 pt-2 text-sm">
          <p>
            <span className="font-medium text-danger">{fmtNum(s.left)} left at this step</span>
            <span className="text-muted"> ({fmtPct(s.leftRate)})</span>
            <span aria-hidden="true" className="text-muted"> · </span>
            <span className="text-muted">
              {fmtNum(s.continued)} {WENT_ON[s.step]}
            </span>
          </p>
          {shown.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted">Last page they were on:</span>
              {shown.map((x) => (
                <span key={x.section ?? "unknown"} className="rounded-full border border-border px-2 py-0.5">
                  {sectionName(x.section)} <strong className="tabular-nums">{fmtNum(x.visits)}</strong>
                </span>
              ))}
              {hidden > 0 && <span className="text-muted">+{fmtNum(hidden)} elsewhere</span>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** The shopping funnel: every visit, how far it got, and how many dropped out where. */
export function FunnelCard({ m, versus }: { m: FunnelModule; versus?: string }) {
  // Null when the pixel counted visits on the dates compared with: nothing is compared before it.
  const missing = m.previous.imported === false ? noEarlierData(m.historyFrom, "visits") : null;
  return (
    <Panel
      id="funnel"
      title="Shopping funnel"
      help={`Every visit to your store in these dates: how far shoppers got, and the page they were on when they left. A visit is one shopper on one day. Shoppers who decline tracking aren't counted, so treat these as trends.${missing ? ` ${missing}` : ""}`}
    >
      {m.visits === 0 ? (
        <Empty>No storefront visits recorded in these dates yet. They show up here within a minute of someone browsing your store.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Visits" value={<AnimatedNumber value={m.visits} format={fmtNum} />} note={<Delta value={m.deltas.visits} label={versus} />} />
            <Stat label="Conversion rate" value={<AnimatedNumber value={m.conversionRate} format={fmtPct} />} note={<Delta value={m.deltas.conversionRate} label={versus} />} />
            <Stat label="Completed a purchase" value={<AnimatedNumber value={m.purchases} format={fmtNum} />} tone="good" note="Visits that ended in a finished checkout." />
            <Stat label="Left without buying" value={<AnimatedNumber value={m.exits} format={fmtNum} />} note={`${fmtPct(m.visits ? m.exits / m.visits : null)} of visits.`} />
          </div>
          <ol className="mt-6" aria-label="Funnel steps">
            {m.steps.map((s, i) => (
              <StepRow key={s.step} s={s} index={i} visits={m.visits} last={i === m.steps.length - 1} />
            ))}
          </ol>
          <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-hidden="true">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent" />Went on to the next step</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-danger/30" />Left at this step</span>
          </p>
        </>
      )}
    </Panel>
  );
}

function PageList({ items, empty, sub }: { items: JourneyPageRow[]; empty: string; sub: (p: JourneyPageRow) => string }) {
  if (items.length === 0) return <p className="mt-3 text-sm text-muted">{empty}</p>;
  const top = Math.max(...items.map((p) => p.visits), 0);
  return (
    <ul className="mt-3 space-y-4">
      {items.map((p) => (
        <BarRow key={p.path} label={<PageName path={p.path} />} value={fmtNum(p.visits)} fraction={top > 0 ? p.visits / top : 0} sub={sub(p)} />
      ))}
    </ul>
  );
}

/** Each part of the site, plus the pages visits started on and the pages they left from. */
export function JourneyCard({ m }: { m: FunnelModule }) {
  const topVisits = Math.max(...m.sections.map((s) => s.visits), 0);
  const mostExits = m.sections.reduce<SectionSummary | null>((best, s) => (s.exits > (best?.exits ?? 0) ? s : best), null)?.section;
  return (
    <Panel
      id="journey"
      title="Where shoppers go on your site"
      help="Each part of your store: how many visits saw it, how many landed there first, and how many left the site from there without buying."
      aside={
        m.pagesPerVisit !== null ? (
          <p className="text-right text-xs text-muted">
            <strong className="text-base text-text">{m.pagesPerVisit}</strong> pages per visit
          </p>
        ) : undefined
      }
    >
      {/* Phones: one compact row per section. */}
      <ul className="divide-y divide-border sm:hidden">
        {m.sections.map((s) => (
          <li key={s.section} className="py-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 font-medium">
                {SECTION_LABEL[s.section]}
                {s.section === mostExits && <Badge tone="danger">Most exits</Badge>}
              </span>
              <span className="tabular-nums">{plural(s.visits, "visit")}</span>
            </div>
            <p className="text-xs text-muted">
              {fmtNum(s.entries)} landed here · {fmtNum(s.exits)} left from here ({fmtPct(s.exitRate)})
            </p>
          </li>
        ))}
      </ul>
      <div className="-mx-1 hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="px-1 pb-2 font-normal">Part of your store</th>
              <th className="px-1 pb-2 text-right font-normal">Visits</th>
              <th className="px-1 pb-2 text-right font-normal">Landed here</th>
              <th className="px-1 pb-2 text-right font-normal">Left from here</th>
              <th className="px-1 pb-2 text-right font-normal">Exit rate</th>
            </tr>
          </thead>
          <tbody>
            {m.sections.map((s) => (
              <tr key={s.section} className="border-t border-border" data-testid={`journey-section-${s.section}`}>
                <td className="px-1 py-2">
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{SECTION_LABEL[s.section]}</span>
                    {s.section === mostExits && <Badge tone="danger">Most exits</Badge>}
                  </span>
                  <span className="mt-1 block h-1.5 max-w-48 rounded-full bg-bg">
                    <span className="animate-grow-x block h-1.5 rounded-full bg-gradient-to-r from-accent to-accent-2" style={{ width: `${topVisits > 0 ? (s.visits / topVisits) * 100 : 0}%` }} />
                  </span>
                </td>
                <td className="px-1 py-2 text-right tabular-nums">{fmtNum(s.visits)}</td>
                <td className="px-1 py-2 text-right tabular-nums">{fmtNum(s.entries)}</td>
                <td className="px-1 py-2 text-right tabular-nums">{fmtNum(s.exits)}</td>
                <td className="px-1 py-2 text-right tabular-nums">{fmtPct(s.exitRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">A visit can see several parts of the store, so visits per part add up to more than the total.</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="min-w-0" data-testid="journey-entry-pages">
          <h3 className="text-sm font-medium">Where visits started</h3>
          <p className="text-xs text-muted">The first page shoppers landed on, and how many of those visits ended in a purchase.</p>
          <PageList
            items={m.entryPages}
            empty="No landing pages recorded yet."
            sub={(p) => `${sectionPrefix(p)}${plural(p.purchases, "purchase")} (${fmtPct(p.visits ? p.purchases / p.visits : null)})`}
          />
        </div>
        <div className="min-w-0" data-testid="journey-exit-pages">
          <h3 className="text-sm font-medium">Where shoppers left</h3>
          <p className="text-xs text-muted">The last page seen on visits that ended without a purchase.</p>
          <PageList
            items={m.exitPages}
            empty="Nobody left without buying in these dates."
            sub={(p) => `${sectionPrefix(p)}${fmtPct(m.exits ? p.visits / m.exits : null)} of everyone who left`}
          />
        </div>
      </div>
    </Panel>
  );
}

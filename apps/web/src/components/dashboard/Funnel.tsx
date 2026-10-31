"use client";
import { FUNNEL_STEP_LABEL, SITE_SECTION_LABEL } from "@app/shared/funnel";
import type { JourneyPageRow, SectionSummary } from "@app/shared/journey";
import { fmtNum, fmtPct } from "@/lib/api";
import { BarRow } from "./Charts";
import { plural } from "./format";
import { Badge, Panel } from "./Primitives";
import type { FunnelModule } from "./types";

export const STEP_LABEL = FUNNEL_STEP_LABEL;

export const SECTION_LABEL = SITE_SECTION_LABEL;

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

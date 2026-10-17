import { Prisma, type Tx } from "@app/db";
import { delta, PURCHASED_STEP, SITE_SECTIONS, summarizeJourney, type Comparison, type DateRange, type JourneyPageRow, type SiteSection } from "@app/shared";
import { localMoment, type Scope } from "./common.js";

// ---------------------------------------------------------------------------
// Storefront funnel (web pixel). One row per shopper per store-local day in
// funnel_visits; see packages/shared/src/journey.ts for what each column means.
// ---------------------------------------------------------------------------

const TOP_PAGES = 8;
const isSection = (s: string | null): s is SiteSection => s !== null && (SITE_SECTIONS as readonly string[]).includes(s);

export async function funnel(tx: Tx, { ws, storeId }: Scope, range: DateRange, previous: Comparison, timeZone: string) {
  const inRange = (r: DateRange) => Prisma.sql`workspace_id = ${ws} AND store_id = ${storeId} AND day BETWEEN ${r.from} AND ${r.to}`;
  // A running comparison's last day: the visits that had started by the same time of day (one
  // recorded before visits were timed counts, as it always did).
  const inComparison = previous.until
    ? Prisma.sql`${inRange(previous)} AND (day < ${previous.to} OR entered_at IS NULL OR entered_at < ${localMoment(previous.to, previous.until, timeZone)})`
    : inRange(previous);

  // How far each visit got, and where the ones that stopped short were last seen.
  const stepRows = await tx.$queryRaw<Array<{ furthest_step: number; exit_section: string | null; visits: number; page_views: number }>>`
    SELECT furthest_step, exit_section, COUNT(*)::int AS visits, SUM(page_views)::int AS page_views
    FROM funnel_visits WHERE ${inRange(range)}
    GROUP BY furthest_step, exit_section`;

  // Visits per site section (bit i of `sections`), and where visits landed.
  const sectionRows = await tx.$queryRaw<Array<{ kind: "visit" | "entry"; section: string | null; n: number }>>`
    SELECT 'visit' AS kind, (${[...SITE_SECTIONS]}::text[])[b.i + 1] AS section, COUNT(*)::int AS n
    FROM funnel_visits v CROSS JOIN generate_series(0, ${SITE_SECTIONS.length - 1}::int) AS b(i)
    WHERE ${inRange(range)} AND v.sections & (1 << b.i) <> 0
    GROUP BY b.i
    UNION ALL
    SELECT 'entry', entry_section, COUNT(*)::int FROM funnel_visits WHERE ${inRange(range)} AND entry_section IS NOT NULL
    GROUP BY entry_section`;

  // Top landing pages (with how many of those visits bought) and top pages people left from without buying.
  const pageRows = await tx.$queryRaw<Array<{ kind: "entry" | "exit"; path: string; section: string; visits: number; purchases: number }>>`
    (SELECT 'entry' AS kind, entry_path AS path, MIN(entry_section) AS section, COUNT(*)::int AS visits,
            COUNT(*) FILTER (WHERE furthest_step = ${PURCHASED_STEP})::int AS purchases
     FROM funnel_visits WHERE ${inRange(range)} AND entry_path IS NOT NULL
     GROUP BY entry_path ORDER BY COUNT(*) DESC, entry_path LIMIT ${TOP_PAGES})
    UNION ALL
    (SELECT 'exit', exit_path, MIN(exit_section), COUNT(*)::int, 0
     FROM funnel_visits WHERE ${inRange(range)} AND exit_path IS NOT NULL AND furthest_step < ${PURCHASED_STEP}
     GROUP BY exit_path ORDER BY COUNT(*) DESC, exit_path LIMIT ${TOP_PAGES})`;

  const [prev] = await tx.$queryRaw<Array<{ visits: number; purchases: number }>>`
    SELECT COUNT(*)::int AS visits, COUNT(*) FILTER (WHERE furthest_step = ${PURCHASED_STEP})::int AS purchases
    FROM funnel_visits WHERE ${inComparison}`;

  const sections = new Map<SiteSection, { section: SiteSection; visits: number; entries: number }>();
  for (const r of sectionRows) {
    if (!isSection(r.section)) continue;
    const row = sections.get(r.section) ?? { section: r.section, visits: 0, entries: 0 };
    if (r.kind === "visit") row.visits += r.n;
    else row.entries += r.n;
    sections.set(r.section, row);
  }
  const summary = summarizeJourney(
    stepRows.map((r) => ({ furthestStep: r.furthest_step, exitSection: isSection(r.exit_section) ? r.exit_section : null, visits: r.visits, pageViews: r.page_views })),
    [...sections.values()],
  );
  const pages = (kind: "entry" | "exit"): JourneyPageRow[] =>
    pageRows
      .filter((r) => r.kind === kind)
      .map((r) => ({ path: r.path, section: isSection(r.section) ? r.section : "other", visits: r.visits, purchases: r.purchases }));

  const prevVisits = prev?.visits ?? 0;
  const prevConversion = prevVisits > 0 ? (prev?.purchases ?? 0) / prevVisits : null;
  return {
    ...summary,
    entryPages: pages("entry"),
    exitPages: pages("exit"),
    previous: { visits: prevVisits, conversionRate: prevConversion },
    deltas: { visits: delta(summary.visits, prevVisits), conversionRate: delta(summary.conversionRate, prevConversion) },
  };
}

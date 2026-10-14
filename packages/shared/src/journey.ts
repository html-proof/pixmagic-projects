/**
 * Storefront journey: which part of the site a page belongs to, and how far a visit got down
 * the shopping funnel. Shared by the pixel ingest (classifies each page as it arrives), the
 * dashboard query (turns stored visits into the funnel) and the web app (labels).
 *
 * A *visit* is one shopper (Shopify's anonymous client id, hashed) on one store-local day.
 * No query strings, checkout tokens or order ids are ever kept: see `cleanPath`.
 */

/** Parts of a Shopify storefront, in the order the dashboard lists them. The index is the bit in `funnel_visits.sections`. */
export const SITE_SECTIONS = ["home", "collection", "product", "search", "cart", "checkout", "content", "account", "other"] as const;
export type SiteSection = (typeof SITE_SECTIONS)[number];

/** Funnel steps in order. A visit's `furthest_step` is the index of the last one it reached. */
export const FUNNEL_STEPS = ["visited", "viewed_product", "added_to_cart", "started_checkout", "purchased"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export const PURCHASED_STEP = FUNNEL_STEPS.length - 1;

/** Pixel event name → funnel step index. Any event at all means the shopper visited. */
export const EVENT_STEP = {
  page_viewed: 0,
  product_viewed: 1,
  product_added_to_cart: 2,
  checkout_started: 3,
  checkout_completed: 4,
} as const satisfies Record<string, number>;
export type PixelEventName = keyof typeof EVENT_STEP;

export const sectionBit = (s: SiteSection) => 1 << SITE_SECTIONS.indexOf(s);

const MAX_PATH = 200;
// Shopify Markets subfolders: /fr, /en-au, /es-419 …
const LOCALE_PREFIX = /^\/[a-z]{2}(?:-[a-z0-9]{2,4})?(?=\/|$)/;

/**
 * A storefront path reduced to what's safe and useful to show a merchant: no query string or
 * fragment, no market prefix, lower case, decoded. Pages that carry a shopper's token in the URL
 * (checkout, thank-you, order status, account) collapse to one fixed path so nothing identifying
 * is stored, and a product reached through a collection is the same product page.
 */
export function cleanPath(raw: string): { section: SiteSection; path: string } {
  let p = raw.split(/[?#]/, 1)[0]!.trim().toLowerCase();
  try {
    p = decodeURIComponent(p);
  } catch {
    // Malformed escapes: keep it as sent.
  }
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/").replace(LOCALE_PREFIX, "") || "/";
  if (p.length > 1) p = p.replace(/\/+$/, "");

  if (p === "/") return { section: "home", path: "/" };
  if (/^\/(checkouts?|thank[-_]you)(\/|$)/.test(p) || /^\/\d+\/(orders|checkouts)\//.test(p)) return { section: "checkout", path: "/checkout" };
  if (/^\/(account|customer_authentication)(\/|$)/.test(p)) return { section: "account", path: "/account" };
  if (/^\/cart(\/|$)/.test(p)) return { section: "cart", path: "/cart" };
  if (/^\/search(\/|$)/.test(p)) return { section: "search", path: "/search" };
  const product = /^(?:\/collections\/[^/]+)?\/products\/([^/]+)/.exec(p);
  if (product) return { section: "product", path: clip(`/products/${product[1]}`) };
  if (/^\/collections(\/|$)/.test(p)) return { section: "collection", path: clip(p) };
  if (/^\/(pages|blogs|policies)(\/|$)/.test(p)) return { section: "content", path: clip(p) };
  return { section: "other", path: clip(p) };
}

const clip = (p: string) => (p.length > MAX_PATH ? p.slice(0, MAX_PATH) : p);

/** Where an event happened, when we can tell. Older pixels send no path; checkout and product events still place the shopper. */
export function eventLocation(name: PixelEventName, path: string | undefined): { section: SiteSection; path: string | null } | null {
  if (path) return cleanPath(path);
  if (name === "checkout_started" || name === "checkout_completed") return { section: "checkout", path: "/checkout" };
  if (name === "product_viewed") return { section: "product", path: null };
  return null;
}

export interface PixelEventIn {
  name: PixelEventName;
  timestamp: Date;
  path?: string;
}

/** One visit's worth of events folded together, ready to merge into its `funnel_visits` row. */
export interface VisitDelta {
  enteredAt: Date | null;
  entrySection: SiteSection | null;
  entryPath: string | null;
  exitedAt: Date | null;
  exitSection: SiteSection | null;
  exitPath: string | null;
  furthestStep: number;
  sections: number;
  pageViews: number;
}

/** Fold one visit's events (any order) into a delta: earliest located event is the entry, latest the exit. */
export function foldVisit(events: PixelEventIn[]): VisitDelta {
  const d: VisitDelta = {
    enteredAt: null,
    entrySection: null,
    entryPath: null,
    exitedAt: null,
    exitSection: null,
    exitPath: null,
    furthestStep: 0,
    sections: 0,
    pageViews: 0,
  };
  for (const ev of events) {
    d.furthestStep = Math.max(d.furthestStep, EVENT_STEP[ev.name]);
    if (ev.name === "page_viewed") d.pageViews++;
    const loc = eventLocation(ev.name, ev.path);
    if (!loc) continue;
    d.sections |= sectionBit(loc.section);
    if (!d.enteredAt || ev.timestamp < d.enteredAt) {
      d.enteredAt = ev.timestamp;
      d.entrySection = loc.section;
      d.entryPath = loc.path;
    }
    if (!d.exitedAt || ev.timestamp >= d.exitedAt) {
      d.exitedAt = ev.timestamp;
      d.exitSection = loc.section;
      d.exitPath = loc.path;
    }
  }
  return d;
}

// ---- Dashboard summary ------------------------------------------------------------------

/** Visits grouped by how far they got and the section they were last seen in. */
export interface StepExitRow {
  furthestStep: number;
  exitSection: SiteSection | null;
  visits: number;
  pageViews: number;
}

export interface SectionRow {
  section: SiteSection;
  visits: number;
  entries: number;
}

export interface JourneyPageRow {
  path: string;
  section: SiteSection;
  visits: number;
  purchases: number;
}

export interface FunnelStepSummary {
  step: FunnelStep;
  /** Visits that reached this step or a later one. */
  reached: number;
  /** Share of all visits that got this far. */
  shareOfVisits: number | null;
  /** Visits that went on to the next step (null on the last step). */
  continued: number | null;
  /** Visits whose furthest step was this one, i.e. left here without going further. 0 on the last step. */
  left: number;
  /** Share of this step's visits that left here. */
  leftRate: number | null;
  /** The section those leavers were last on, largest first. `null` = page not recorded. */
  leftFrom: Array<{ section: SiteSection | null; visits: number }>;
}

export interface SectionSummary {
  section: SiteSection;
  /** Visits that saw at least one page in this section. */
  visits: number;
  /** Visits that landed on the site here. */
  entries: number;
  /** Visits that left the site from here without buying. */
  exits: number;
  /** exits ÷ visits. */
  exitRate: number | null;
}

export interface JourneySummary {
  visits: number;
  purchases: number;
  conversionRate: number | null;
  pagesPerVisit: number | null;
  steps: FunnelStepSummary[];
  sections: SectionSummary[];
  /** Visits that left without buying. */
  exits: number;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export function summarizeJourney(stepRows: StepExitRow[], sectionRows: SectionRow[]): JourneySummary {
  const atStep = FUNNEL_STEPS.map(() => 0);
  const leftFrom = FUNNEL_STEPS.map(() => new Map<SiteSection | null, number>());
  const exitsBySection = new Map<SiteSection, number>();
  let pageViews = 0;
  for (const r of stepRows) {
    const step = Math.min(Math.max(r.furthestStep, 0), PURCHASED_STEP);
    atStep[step]! += r.visits;
    pageViews += r.pageViews;
    if (step === PURCHASED_STEP) continue;
    const m = leftFrom[step]!;
    m.set(r.exitSection, (m.get(r.exitSection) ?? 0) + r.visits);
    if (r.exitSection) exitsBySection.set(r.exitSection, (exitsBySection.get(r.exitSection) ?? 0) + r.visits);
  }
  // reached[k] = visits whose furthest step is k or later.
  const reached = atStep.map((_, k) => atStep.slice(k).reduce((a, b) => a + b, 0));
  const visits = reached[0]!;
  const purchases = atStep[PURCHASED_STEP]!;

  const steps = FUNNEL_STEPS.map((step, k): FunnelStepSummary => {
    const last = k === PURCHASED_STEP;
    const left = last ? 0 : atStep[k]!;
    return {
      step,
      reached: reached[k]!,
      shareOfVisits: ratio(reached[k]!, visits),
      continued: last ? null : reached[k + 1]!,
      left,
      leftRate: last ? null : ratio(left, reached[k]!),
      leftFrom: [...leftFrom[k]!.entries()]
        .map(([section, v]) => ({ section, visits: v }))
        .sort((a, b) => b.visits - a.visits),
    };
  });

  const bySection = new Map(sectionRows.map((r) => [r.section, r]));
  const sections = SITE_SECTIONS.map((section): SectionSummary => {
    const r = bySection.get(section);
    const v = r?.visits ?? 0;
    const exits = exitsBySection.get(section) ?? 0;
    return { section, visits: v, entries: r?.entries ?? 0, exits, exitRate: ratio(exits, v) };
  })
    .filter((s) => s.visits > 0 || s.entries > 0 || s.exits > 0)
    .sort((a, b) => b.visits - a.visits);

  return {
    visits,
    purchases,
    conversionRate: ratio(purchases, visits),
    pagesPerVisit: visits > 0 ? Math.round((pageViews / visits) * 10) / 10 : null,
    steps,
    sections,
    exits: visits - purchases,
  };
}

// ---- Reading the summary (the dashboard's sentences) ---------------------------------------

/**
 * The step most visits stopped at without going further: the biggest drop-off. The last step
 * (a purchase) isn't a drop-off; on a tie the earlier step wins. Null with fewer than two steps.
 */
export function biggestDropOff(steps: FunnelStepSummary[]): FunnelStepSummary | null {
  return steps.length > 1 ? steps.slice(0, -1).reduce((a, b) => (b.left > a.left ? b : a)) : null;
}

/** The part of the site most of a step's leavers were last on, when it was recorded. */
export function dropOffSection(step: FunnelStepSummary | null | undefined): SiteSection | null | undefined {
  return step?.leftFrom.find((x) => x.section)?.section;
}

/** An entry page needs this many visits before its share of buyers says anything. */
const MIN_ENTRY_VISITS = 5;

/** The landing page whose visits bought most often (of those with at least 5 visits); on a tie the first listed. */
export function bestEntryPage(pages: JourneyPageRow[]): JourneyPageRow | undefined {
  return pages.filter((p) => p.visits >= MIN_ENTRY_VISITS).sort((a, b) => b.purchases / b.visits - a.purchases / a.visits)[0];
}

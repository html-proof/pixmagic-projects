/**
 * The Shopping Funnel page's maths: what the pixel ingest records beyond the visit itself (the kind
 * of device, where the visit came from, the products a visit looked at, added to cart, took to
 * checkout and bought), the filters, each step-to-step transition with its
 * progression and drop-off, funnels per segment, the observations the page makes (only where the
 * numbers support them) and its checklist of recommended actions. Shared by the ingest, the report
 * (packages/core/src/reports/funnel.ts) and the web app.
 *
 * Every figure here is about *tracked visits* (journey.ts): one shopper (a hashed browser id) on one
 * store-local day, recorded by the bizinsights pixel for shoppers who accept analytics tracking.
 * Each step counts visits that reached it or a later one, so every rate below compares the same
 * visits with themselves: no step is divided by a count from another source.
 *
 * Imported by the UI through `@app/shared/funnel`: relative imports stay extensionless.
 */
import { describeDevice, type DeviceInfo } from "./device";
import { cleanPath, FUNNEL_STEPS, PURCHASED_STEP, type FunnelStep, type PixelEventName, type SiteSection } from "./journey";
import { classifyVisit, type TrafficSource } from "./traffic";

// ---- Names ---------------------------------------------------------------------------------

export const FUNNEL_STEP_LABEL: Record<FunnelStep, string> = {
  visited: "Visited your store",
  viewed_product: "Viewed a product",
  added_to_cart: "Added to cart",
  started_checkout: "Started checkout",
  purchased: "Completed a purchase",
};

export const SITE_SECTION_LABEL: Record<SiteSection, string> = {
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

// ---- What the ingest records ---------------------------------------------------------------

export const FUNNEL_DEVICES = ["mobile", "tablet", "desktop", "unknown"] as const;
export type FunnelDevice = (typeof FUNNEL_DEVICES)[number];
export const FUNNEL_DEVICE_LABEL: Record<FunnelDevice, string> = { mobile: "Mobile", tablet: "Tablet", desktop: "Desktop", unknown: "Unknown device" };

/**
 * The kind of device a pixel request came from, by the browser's own User-Agent (describeDevice),
 * and Chromium's Sec-CH-UA-Mobile hint where the User-Agent can't tell. An iPad asking for desktop
 * sites (Safari's default) says it is a Mac, so it counts as a desktop, as in most analytics tools.
 */
export function funnelDevice(info: DeviceInfo, mobileHint?: string | null): FunnelDevice {
  const kind = describeDevice(info).kind;
  if (kind === "phone") return "mobile";
  if (kind === "tablet") return "tablet";
  if (kind === "laptop" || kind === "desktop") return "desktop";
  return mobileHint?.trim() === "?1" ? "mobile" : "unknown";
}

/**
 * Ad click ids the pixel says a landing link carried, by name only (never the value): the ones
 * classifyVisit reads in an order's landing page.
 */
export const CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid"] as const;
export type ClickId = (typeof CLICK_IDS)[number];

/**
 * What the pixel sends about how a shopper arrived, with the page view of a page reached from
 * outside the store (another site, or none: typed, bookmarked, an app): the referring site's host,
 * the landing link's utm_source and utm_medium, and which ad click ids it carried. Never a URL or a
 * query string. Pixels released before it send none.
 */
export interface PixelArrival {
  ref?: string;
  utmSource?: string;
  utmMedium?: string;
  click?: ClickId[];
}

/** Shopify's own hosts: the store's myshopify.com address and Shopify's customer accounts are the store, not a source. */
const SHOPIFY_HOST = /(^|\.)(myshopify\.com|shopify\.com)$/;

/**
 * Where a visit came from, from the pixel's arrival on the page at `path`: the same sources, by the
 * same rules, as an order's last visit (classifyVisit), so visits and orders by source read alike.
 * An arrival with no referrer and no tags is direct. Null when the page isn't really an arrival:
 * checkout, thank-you and account pages are reached back from a payment provider or a sign-in.
 */
export function arrivalSource(a: PixelArrival, path: string | undefined): TrafficSource | null {
  if (path) {
    const { section } = cleanPath(path);
    if (section === "checkout" || section === "account") return null;
  }
  const ref = (a.ref ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (ref && SHOPIFY_HOST.test(ref)) return null;
  // classifyVisit reads click ids from the landing page's query: only their names are known here.
  const clicks = new URLSearchParams();
  for (const c of a.click ?? []) clicks.set(c, "1");
  return classifyVisit({ referrerUrl: ref ? `https://${ref}/` : null, landingPage: `/?${clicks}`, utmParameters: { source: a.utmSource ?? null, medium: a.utmMedium ?? null } }, "web").source;
}

/** `funnel_product_visits.steps`: the product page was viewed. */
export const PRODUCT_VIEWED = 1;
/** `funnel_product_visits.steps`: added to cart from the product's own page. */
export const PRODUCT_ADDED = 2;
/**
 * `funnel_product_visits.steps`: added to cart somewhere other than its own page (a quick add from a
 * collection or search, a cart drawer, another product's page). Only pixels that name the product
 * added (the release that sends arrivals) record it.
 */
export const PRODUCT_QUICK_ADDED = 4;
/** `funnel_product_visits.steps`: in a checkout the visit started (pixels that name products only). */
export const PRODUCT_CHECKOUT = 8;
/** `funnel_product_visits.steps`: in a checkout the visit completed (likewise); a completed checkout was started, so 8 is set too. */
export const PRODUCT_PURCHASED = 16;

/** The product a storefront page is for, by its handle: "/products/tee" and "/collections/x/products/tee" → "tee". */
export function productHandle(path: string | null | undefined): string | null {
  if (!path) return null;
  const loc = cleanPath(path);
  return loc.section === "product" ? loc.path.slice("/products/".length) || null : null;
}

/**
 * What one pixel event says about products. A view is the product page's. An add names its product
 * (`products`, newer pixels): added on that product's own page, or quickly from anywhere
 * else, and the page it happened on was seen. An older pixel names none, so its add is the product
 * page's it happened on, and an add from anywhere else isn't put down to any product. A checkout
 * started or completed names every product it held.
 */
export function productStepsOf(name: PixelEventName, path: string | undefined, products?: readonly string[]): Array<{ handle: string; steps: number }> {
  const page = productHandle(path);
  // The same handle as a product page's address gives, so both read alike.
  const named = [...new Set((products ?? []).map((h) => productHandle(`/products/${h}`)).filter((h): h is string => !!h))];
  switch (name) {
    case "product_viewed":
      return page ? [{ handle: page, steps: PRODUCT_VIEWED }] : [];
    case "product_added_to_cart": {
      if (!named.length) return page ? [{ handle: page, steps: PRODUCT_VIEWED | PRODUCT_ADDED }] : [];
      const out = named.map((handle) => ({ handle, steps: handle === page ? PRODUCT_VIEWED | PRODUCT_ADDED : PRODUCT_QUICK_ADDED }));
      return page && !named.includes(page) ? [...out, { handle: page, steps: PRODUCT_VIEWED }] : out;
    }
    case "checkout_started":
      return named.map((handle) => ({ handle, steps: PRODUCT_CHECKOUT }));
    case "checkout_completed":
      return named.map((handle) => ({ handle, steps: PRODUCT_CHECKOUT | PRODUCT_PURCHASED }));
    default:
      return [];
  }
}

// ---- Filters --------------------------------------------------------------------------------

export const VISITOR_KINDS = ["new", "returning"] as const;
export type VisitorKind = (typeof VISITOR_KINDS)[number];
export const VISITOR_KIND_LABEL: Record<VisitorKind, string> = { new: "New visitors", returning: "Returning visitors" };

/**
 * Narrows every visit figure on the page to some of the visits. `returning`: the same browser was
 * tracked on an earlier day; `landing`: the part of the store the visit started on; `source`: where
 * the visit came from (arrivalSource; only for members who see traffic sources).
 */
export interface FunnelFilter {
  device?: FunnelDevice;
  visitor?: VisitorKind;
  landing?: SiteSection;
  /** An ISO 3166 code. */
  country?: string;
  source?: TrafficSource;
}

export const COUNTRY_CODE = /^[A-Z]{2}$/;

// ---- Steps, transitions and segments ----------------------------------------------------------

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/** Visits that reached each step or a later one, from visits by their furthest step (index 0 … 4). */
export function reachedCounts(atStep: readonly number[]): number[] {
  return FUNNEL_STEPS.map((_, k) => atStep.slice(k, PURCHASED_STEP + 1).reduce((a, b) => a + (b ?? 0), 0));
}

/** Rows of visits grouped by furthest step (as the report's queries return them) → visits per furthest step. */
export function countsByStep(rows: ReadonlyArray<{ furthestStep: number; visits: number }>): number[] {
  const at = FUNNEL_STEPS.map(() => 0);
  for (const r of rows) at[Math.min(Math.max(r.furthestStep, 0), PURCHASED_STEP)]! += r.visits;
  return at;
}

/** The smallest group a rate is compared on, and the 95% two-sided threshold. */
export const MIN_COMPARED = 30;
export const Z_95 = 1.96;

/**
 * How far apart two proportions are, in standard errors (the pooled two-proportion z-test): x1 of
 * n1 against x2 of n2. Null when the test can't be read: a group under MIN_COMPARED, or fewer than
 * five expected successes or failures in a group (the normal approximation's usual rule).
 */
export function proportionZ(x1: number, n1: number, x2: number, n2: number): number | null {
  if (n1 < MIN_COMPARED || n2 < MIN_COMPARED) return null;
  const p = (x1 + x2) / (n1 + n2);
  if ([n1, n2].some((n) => n * p < 5 || n * (1 - p) < 5)) return null;
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? (x1 / n1 - x2 / n2) / se : null;
}

/** Whether x1/n1 and x2/n2 differ by more than chance would explain, at 95%. */
export const significant = (z: number | null): boolean => z !== null && Math.abs(z) >= Z_95;

export interface FunnelTransition {
  from: FunnelStep;
  to: FunnelStep;
  /** Visits that reached `from` (or later). */
  fromCount: number;
  /** Of those, visits that reached `to` (or later). */
  toCount: number;
  /** Visits that reached `from` and stopped there: fromCount − toCount. */
  lost: number;
  /** toCount ÷ fromCount. */
  progression: number | null;
  /** 1 − progression. */
  dropOff: number | null;
}

/** Each step to the next, from visits reached per step (reachedCounts). */
export function funnelTransitions(reached: readonly number[]): FunnelTransition[] {
  return FUNNEL_STEPS.slice(0, -1).map((from, k): FunnelTransition => {
    const fromCount = reached[k] ?? 0;
    const toCount = reached[k + 1] ?? 0;
    const progression = ratio(toCount, fromCount);
    return {
      from,
      to: FUNNEL_STEPS[k + 1]!,
      fromCount,
      toCount,
      lost: fromCount - toCount,
      progression,
      dropOff: progression === null ? null : 1 - progression,
    };
  });
}

/** The transition that lost the most visits (on a tie the earlier one); null when none lost any. */
export function largestDropOff(transitions: readonly FunnelTransition[]): number | null {
  let best: number | null = null;
  transitions.forEach((t, i) => {
    if (t.lost > 0 && (best === null || t.lost > transitions[best]!.lost)) best = i;
  });
  return best;
}

/** One segment's funnel (a device, a country, a kind of landing page, new or returning visitors). */
export interface SegmentFunnel {
  key: string;
  visits: number;
  /** Visits that reached each step or a later one. */
  reached: number[];
  /** Each transition's progression rate (4). */
  progression: Array<number | null>;
  /** Visits that bought ÷ visits. */
  conversionRate: number | null;
  /** Visits that bought ÷ visits that started checkout. */
  checkoutCompletion: number | null;
}

export function segmentFunnel(key: string, atStep: readonly number[]): SegmentFunnel {
  const reached = reachedCounts(atStep);
  const visits = reached[0]!;
  return {
    key,
    visits,
    reached,
    progression: reached.slice(0, -1).map((n, k) => ratio(reached[k + 1]!, n)),
    conversionRate: ratio(reached[PURCHASED_STEP]!, visits),
    checkoutCompletion: ratio(reached[PURCHASED_STEP]!, reached[PURCHASED_STEP - 1]!),
  };
}

// ---- Observations ---------------------------------------------------------------------------

export type InsightTone = "positive" | "negative" | "neutral";

/**
 * One thing the numbers show, with the figures behind it. The page words them; nothing here is a
 * cause, only a measured difference, and each kind is made only when the test behind it holds.
 * Nothing is set against other dates: every observation is within the dates asked about.
 *
 * - `largest_drop`: where most visits stopped (always true of the numbers; at least 30 visits).
 * - `segment_gap`: one device, or new against returning visitors, buys or completes checkout at a
 *   different rate than the other (proportionZ).
 * - `product_interest`: a product page many visits saw is added to cart less often than the store's
 *   other product pages (proportionZ against the rest).
 */
export type FunnelInsight =
  | { kind: "largest_drop"; tone: InsightTone; from: FunnelStep; to: FunnelStep; lost: number; dropOff: number; fromCount: number }
  | {
      kind: "segment_gap";
      tone: InsightTone;
      dimension: "device" | "visitor";
      metric: "conversion" | "checkout_completion";
      better: string;
      worse: string;
      betterRate: number;
      worseRate: number;
      /** The visits (or, for checkout completion, checkouts) each rate is out of. */
      betterOf: number;
      worseOf: number;
    }
  | { kind: "product_interest"; tone: InsightTone; handle: string; title: string | null; viewed: number; added: number; rate: number; othersRate: number };

export interface InsightInput {
  /** Visits reached per step in the dates. */
  reached: readonly number[];
  devices: readonly SegmentFunnel[];
  visitors: readonly SegmentFunnel[];
  products: ReadonlyArray<{ handle: string; title: string | null; viewed: number; added: number }>;
}

/** Most observations shown at once. */
export const MAX_INSIGHTS = 6;

const by = <T>(score: (x: T) => number) => (a: T, b: T) => score(b) - score(a);

/** The observations the numbers support, strongest first (at most MAX_INSIGHTS). */
export function funnelInsights(input: InsightInput): FunnelInsight[] {
  const out: Array<{ insight: FunnelInsight; score: number }> = [];
  const { reached } = input;
  const visits = reached[0] ?? 0;

  const transitions = funnelTransitions(reached);
  const drop = largestDropOff(transitions);
  if (drop !== null && visits >= MIN_COMPARED) {
    const t = transitions[drop]!;
    // Always first: it is what the page is for.
    out.push({ insight: { kind: "largest_drop", tone: "neutral", from: t.from, to: t.to, lost: t.lost, dropOff: t.dropOff ?? 0, fromCount: t.fromCount }, score: Number.POSITIVE_INFINITY });
  }

  const gap = (dimension: "device" | "visitor", a: SegmentFunnel | undefined, b: SegmentFunnel | undefined) => {
    if (!a || !b) return;
    const conv = proportionZ(a.reached[PURCHASED_STEP]!, a.visits, b.reached[PURCHASED_STEP]!, b.visits);
    const ca = a.reached[PURCHASED_STEP - 1]!;
    const cb = b.reached[PURCHASED_STEP - 1]!;
    const comp = proportionZ(a.reached[PURCHASED_STEP]!, ca, b.reached[PURCHASED_STEP]!, cb);
    const pick = significant(conv) && (!significant(comp) || Math.abs(conv!) >= Math.abs(comp!)) ? { metric: "conversion" as const, z: conv!, of: [a.visits, b.visits] } : significant(comp) ? { metric: "checkout_completion" as const, z: comp!, of: [ca, cb] } : null;
    if (!pick) return;
    const [hi, lo, hiOf, loOf] = pick.z > 0 ? [a, b, pick.of[0]!, pick.of[1]!] : [b, a, pick.of[1]!, pick.of[0]!];
    const rate = (s: SegmentFunnel) => (pick.metric === "conversion" ? s.conversionRate : s.checkoutCompletion) ?? 0;
    out.push({
      insight: { kind: "segment_gap", tone: "neutral", dimension, metric: pick.metric, better: hi.key, worse: lo.key, betterRate: rate(hi), worseRate: rate(lo), betterOf: hiOf, worseOf: loOf },
      score: Math.abs(pick.z),
    });
  };
  const device = (k: FunnelDevice) => input.devices.find((s) => s.key === k);
  gap("device", device("mobile"), device("desktop"));
  gap("visitor", input.visitors.find((s) => s.key === "new"), input.visitors.find((s) => s.key === "returning"));

  // Product pages added to cart less often than the store's others, the clearest two.
  const viewedAll = input.products.reduce((a, p) => a + p.viewed, 0);
  const addedAll = input.products.reduce((a, p) => a + p.added, 0);
  input.products
    .map((p) => ({ p, z: proportionZ(p.added, p.viewed, addedAll - p.added, viewedAll - p.viewed) }))
    .filter((x): x is { p: (typeof input.products)[number]; z: number } => x.z !== null && x.z <= -Z_95)
    .sort((a, b) => a.z - b.z)
    .slice(0, 2)
    .forEach(({ p, z }) =>
      out.push({
        insight: { kind: "product_interest", tone: "negative", handle: p.handle, title: p.title, viewed: p.viewed, added: p.added, rate: p.added / p.viewed, othersRate: (addedAll - p.added) / (viewedAll - p.viewed) },
        score: Math.abs(z),
      }),
    );

  return out.sort(by((x) => x.score)).slice(0, MAX_INSIGHTS).map((x) => x.insight);
}

// ---- Products ---------------------------------------------------------------------------------

/** A product page needs this many viewing visits before its add-to-cart rate is compared. */
export const MIN_PRODUCT_VIEWS = 20;

export type ProductSuggestion = "review_page" | "check_checkout" | "landing_exits" | "sold_untracked";

/**
 * What the numbers suggest looking at for one product, or null when nothing stands out:
 *
 * - `review_page`: visits that view it add it to cart less often than the store's other product
 *   pages (proportionZ, at least MIN_PRODUCT_VIEWS viewing visits).
 * - `check_checkout`: added to cart from its page by 10 visits or more, and no order holds it in the
 *   same dates (only when the member sees product sales).
 * - `landing_exits`: visits that start on its page leave the store from that same page (without
 *   buying) more often than visits that start on the store's other product pages (proportionZ).
 * - `sold_untracked`: ordered, yet no tracked visit viewed it, added it from elsewhere or took it to
 *   checkout (links to checkout, other channels, shoppers who declined tracking).
 */
export function productSuggestion(
  p: { viewed: number | null; added: number | null; landed: number; landedLeft: number; orders?: number; quickAdded?: number | null; checkouts?: number | null },
  others: { viewed: number; added: number; landed: number; landedLeft: number },
): ProductSuggestion | null {
  const viewed = p.viewed ?? 0;
  const added = p.added ?? 0;
  if (viewed >= MIN_PRODUCT_VIEWS) {
    const z = proportionZ(added, viewed, others.added, others.viewed);
    if (z !== null && z <= -Z_95) return "review_page";
  }
  if (p.orders !== undefined && added >= 10 && p.orders === 0) return "check_checkout";
  const zl = proportionZ(p.landedLeft, p.landed, others.landedLeft, others.landed);
  if (zl !== null && zl >= Z_95) return "landing_exits";
  if (p.viewed === 0 && !p.quickAdded && !p.checkouts && (p.orders ?? 0) > 0) return "sold_untracked";
  return null;
}

// ---- Recommended actions ---------------------------------------------------------------------

/**
 * The checklist under the funnel: practical things to look at for each step, which members can tick
 * off per store (funnel_action_checks). Suggestions to try, never claimed causes.
 */
export const FUNNEL_ACTIONS = [
  { id: "visits.traffic_quality", step: "visited", label: "Review traffic quality", detail: "Look at where visits come from and how many of them go on to view a product, not only how many arrive." },
  { id: "visits.best_channels", step: "visited", label: "Find your best channels", detail: "Compare which sources and campaigns bring orders (Sales channels) and put more behind the ones that do." },
  { id: "visits.landing_relevance", step: "visited", label: "Make landing pages match what brought shoppers", detail: "An ad or post about one product should land on that product, with the same price and offer." },
  { id: "discovery.product_content", step: "viewed_product", label: "Improve product-page content", detail: "Clear titles, sizes and materials, and answers to the questions customers ask you most." },
  { id: "discovery.images", step: "viewed_product", label: "Use clear product images", detail: "Several sharp photos, including the product in use and at its real size." },
  { id: "discovery.price_availability", step: "viewed_product", label: "Make price and availability easy to see", detail: "Show the price, stock and delivery time near the Add to cart button." },
  { id: "cart.pricing_shipping", step: "added_to_cart", label: "Be upfront about shipping costs", detail: "Shoppers often leave when shipping appears late. Show the cost, or the free-shipping threshold, on product and cart pages." },
  { id: "cart.usability", step: "added_to_cart", label: "Check the cart works well on phones", detail: "Change quantities, remove an item and go to checkout on a phone, as a shopper would." },
  { id: "cart.discounts", step: "added_to_cart", label: "Check discounts and cart controls work", detail: "Try your current discount codes and automatic discounts in the cart." },
  { id: "checkout.usability", step: "started_checkout", label: "Walk through your checkout", detail: "Place a test order on a phone and on a computer and note anything slow or confusing." },
  { id: "checkout.costs_payment", step: "started_checkout", label: "Review shipping fees and payment options", detail: "Unexpected costs at checkout, or a missing way to pay, stop orders at the last step." },
  { id: "checkout.errors", step: "started_checkout", label: "Look for checkout errors", detail: "Check Shopify's abandoned checkouts and any payment declines reported by your payment provider." },
  { id: "purchase.trends", step: "purchased", label: "Review conversion trends", detail: "Look at the conversion trend after each change you make, over a few weeks." },
  { id: "purchase.order_value", step: "purchased", label: "Monitor order value", detail: "Watch average order value and revenue alongside conversion: more orders at a much lower value may not be better." },
  { id: "purchase.winners", step: "purchased", label: "Learn from what sells", detail: "Find the products and channels that lead to orders, and give them more room on your store." },
] as const satisfies ReadonlyArray<{ id: string; step: FunnelStep; label: string; detail: string }>;

export type FunnelActionId = (typeof FUNNEL_ACTIONS)[number]["id"];
const ACTION_IDS: ReadonlySet<string> = new Set(FUNNEL_ACTIONS.map((a) => a.id));
export const isFunnelAction = (id: string): id is FunnelActionId => ACTION_IDS.has(id);

/**
 * Where an order's customer came from, in Shopify's own record: the visit that ended in the order
 * (GraphQL `Order.customerJourneySummary.lastVisit`), or, in a REST webhook, the order's
 * `landing_site` and `referring_site`. This is the store's view of a sale (the last visit before
 * it), not an ad platform's attribution, and it needs nothing beyond `read_orders`.
 *
 * Only a few words are kept per order: the source, whether the link was a tagged ad, the campaign
 * name from the link's UTM tags and the referring site's host. Never the URLs themselves: landing
 * pages can carry a customer's email or a cart token in their query string.
 */

export const TRAFFIC_SOURCES = ["facebook", "instagram", "google", "youtube", "tiktok", "bing", "pinterest", "x", "whatsapp", "email", "direct", "other", "unknown"] as const;
export type TrafficSource = (typeof TRAFFIC_SOURCES)[number];

/**
 * paid: a link tagged as an ad (utm_medium cpc/paid/..., a Google or TikTok click id, Shopify's
 * "ad" tactic); unpaid: from that platform without an ad tag (a post, a search result, or an ad
 * whose links carry no tags); email; direct; referral (another website); unknown.
 */
export type TrafficMedium = "paid" | "unpaid" | "email" | "direct" | "referral" | "unknown";

export interface Traffic {
  source: TrafficSource;
  medium: TrafficMedium;
  /** The link's utm_campaign, as the merchant wrote it. */
  campaign: string | null;
  /** The referring site's host (no path, no query), when there was one. */
  referrerHost: string | null;
}

export const TRAFFIC_LABEL: Record<TrafficSource, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  google: "Google",
  youtube: "YouTube",
  tiktok: "TikTok",
  bing: "Bing",
  pinterest: "Pinterest",
  x: "X (Twitter)",
  whatsapp: "WhatsApp",
  email: "Email",
  direct: "Direct",
  other: "Other websites",
  unknown: "Not recorded",
};

/** What Shopify's GraphQL CustomerVisit carries (the fields asked for in ordersQuery). */
export interface ShopifyVisit {
  source?: string | null;
  sourceType?: string | null;
  referrerUrl?: string | null;
  landingPage?: string | null;
  utmParameters?: { source?: string | null; medium?: string | null; campaign?: string | null } | null;
}

const PAID_MEDIUMS = /^(cpc|ppc|cpm|cpv|paid|paid[-_ ]?(social|search|media)|paidsocial|ads?|display|retargeting|sponsored|boost(ed)?)$/i;
const EMAIL_MEDIUMS = /^(e-?mail|newsletter|sms|klaviyo|shopify[-_ ]?email)$/i;
const PAID_TACTICS = new Set(["AD", "DISPLAY", "RETARGETING"]);
const MESSAGE_TACTICS = new Set(["NEWSLETTER", "ABANDONED_CART", "FOLLOW_UP", "RECEIPT", "TRANSACTIONAL", "NOTIFICATION", "MESSAGE", "LOYALTY"]);

/** A utm_source, Shopify's `source` word or a host, as one of the platforms. */
function platform(word: string | null | undefined): TrafficSource | null {
  const w = (word ?? "").trim().toLowerCase();
  if (!w) return null;
  if (/(^|\.)(instagram\.com|ig\.me)$/.test(w) || /^(ig|instagram)(_|$)/.test(w)) return "instagram";
  if (/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/.test(w) || /^(fb|facebook|meta|an|msg|messenger)(_|$)/.test(w)) return "facebook";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(w) || /^(youtube|yt)$/.test(w)) return "youtube";
  if (/(^|\.)google\.(com?\.[a-z]{2}|[a-z]{2,3})$/.test(w) || /^(google|adwords|gads|google[-_ ]?ads)$/.test(w)) return "google";
  if (/(^|\.)tiktok\.com$/.test(w) || w === "tiktok") return "tiktok";
  if (/(^|\.)bing\.com$/.test(w) || /^(bing|microsoft|msn)$/.test(w)) return "bing";
  if (/(^|\.)pinterest\.(com?\.[a-z]{2}|[a-z]{2,3})$/.test(w) || /^(pinterest|pin)$/.test(w)) return "pinterest";
  if (/^(t\.co|twitter\.com|x\.com|www\.x\.com|www\.twitter\.com)$/.test(w) || /^(twitter|x)$/.test(w)) return "x";
  if (/(^|\.)(whatsapp\.com|wa\.me)$/.test(w) || /^(whatsapp|wa)$/.test(w)) return "whatsapp";
  if (/^(e-?mail|newsletter|klaviyo|mailchimp|omnisend|shopify[-_ ]?email)$/.test(w)) return "email";
  return null;
}

function parseUrl(u: string | null | undefined, base = "https://store.invalid"): URL | null {
  if (!u) return null;
  try {
    return new URL(u, base);
  } catch {
    return null;
  }
}

const clean = (s: string | null | undefined, max: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Classify one visit. `channel` is the order's sales channel (source_name): without any visit data
 * an online-store order counts as direct, anything else (POS, draft orders, apps) as not recorded.
 */
export function classifyVisit(v: ShopifyVisit | null | undefined, channel?: string | null): Traffic {
  const landing = parseUrl(v?.landingPage);
  const q = landing?.searchParams;
  const referrer = parseUrl(v?.referrerUrl);
  const referrerHost = referrer && referrer.hostname !== "store.invalid" ? referrer.hostname.replace(/^www\./, "").toLowerCase().slice(0, 120) : null;
  const utmSource = v?.utmParameters?.source ?? q?.get("utm_source") ?? null;
  const utmMedium = v?.utmParameters?.medium ?? q?.get("utm_medium") ?? null;
  const campaign = clean(v?.utmParameters?.campaign ?? q?.get("utm_campaign"), 120);
  const tactic = (v?.sourceType ?? "").toUpperCase();
  const clickId = (name: string) => !!q?.get(name);
  const googleClick = clickId("gclid") || clickId("gbraid") || clickId("wbraid") || clickId("gclsrc");

  let source: TrafficSource | null =
    platform(utmSource) ??
    (googleClick ? "google" : null) ??
    (clickId("ttclid") ? "tiktok" : null) ??
    (clickId("msclkid") ? "bing" : null) ??
    (referrerHost ? platform(referrerHost) : null) ??
    // fbclid rides on every link out of Facebook and Instagram, ads or not.
    (clickId("fbclid") ? "facebook" : null) ??
    platform(v?.source);
  if (!source && (EMAIL_MEDIUMS.test(utmMedium ?? "") || MESSAGE_TACTICS.has(tactic))) source = "email";
  if (!source && referrerHost) source = "other";
  if (!source && (tactic === "DIRECT" || (v?.source ?? "").toLowerCase() === "direct")) source = "direct";
  if (!source && !v) source = "unknown";
  if (!source) {
    // A visit with nothing to go on: an online-store visit typed in or bookmarked, else unknown.
    const web = !channel || /^(web|checkout_next)$/i.test(channel.trim());
    source = web && (v?.landingPage || v?.source) ? "direct" : "unknown";
  }

  const paid = PAID_MEDIUMS.test((utmMedium ?? "").trim()) || PAID_TACTICS.has(tactic) || googleClick || clickId("ttclid") || clickId("msclkid");
  const medium: TrafficMedium =
    source === "unknown" ? "unknown"
    : source === "direct" ? "direct"
    : paid ? "paid"
    : source === "email" ? "email"
    : source === "other" ? "referral"
    : "unpaid";
  return { source, medium, campaign, referrerHost };
}

/** A REST order payload's landing_site / referring_site, as a visit. Null when it has neither. */
export function restVisit(o: { landing_site?: unknown; referring_site?: unknown }): ShopifyVisit | null {
  const landing = typeof o.landing_site === "string" && o.landing_site.trim() ? o.landing_site.trim() : null;
  const referrer = typeof o.referring_site === "string" && o.referring_site.trim() ? o.referring_site.trim() : null;
  if (!landing && !referrer) return null;
  return { landingPage: landing, referrerUrl: referrer };
}

/**
 * Paid vs organic: each order by how its last visit came, as Shopify recorded it (last click, from the
 * order's customer journey), never what an ad platform credits to its ads. "paid": a link tagged as an
 * ad (TrafficMedium "paid"; an ad whose links carry no tags reads as organic); "organic": from a search
 * engine, a social network or another website without an ad tag ("unpaid", "referral"); "email": email
 * and messages; "direct": a typed or bookmarked address; "unknown": Shopify recorded no visit (POS,
 * draft orders, apps).
 */
export const TRAFFIC_SPLITS = ["paid", "organic", "email", "direct", "unknown"] as const;
export type TrafficSplit = (typeof TRAFFIC_SPLITS)[number];

export const TRAFFIC_SPLIT_LABEL: Record<TrafficSplit, string> = {
  paid: "Paid ads",
  organic: "Organic",
  email: "Email and messages",
  direct: "Direct",
  unknown: "Not recorded",
};

/** The split an order's traffic_medium belongs to; anything not known as a medium is "unknown". */
export function trafficSplitOf(medium: string | null | undefined): TrafficSplit {
  switch (medium) {
    case "paid":
      return "paid";
    case "unpaid":
    case "referral":
      return "organic";
    case "email":
      return "email";
    case "direct":
      return "direct";
    default:
      return "unknown";
  }
}

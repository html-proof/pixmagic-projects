/**
 * WhatsApp Business Platform (Cloud API): the pure parts. Phone numbers, which notification goes
 * out for which store event, the template library bizinsights can create for a merchant, how a Graph
 * API error should be handled, quiet hours, and the automation rules' conditions. Everything that
 * touches the network or the database is in packages/core/src/whatsapp.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/**
 * Calling code and national trunk prefix per ISO country. A number typed without "+" is only
 * turned into an international one when its country is known here: guessing would send a
 * customer's order details to a stranger. `trunk` is what a local number starts with that the
 * international form drops ("0412 345 678" in AU → +61 412 345 678); Italy keeps its 0.
 */
const COUNTRIES: Record<string, { code: string; trunk?: string; len?: [number, number] }> = {
  AE: { code: "971", trunk: "0", len: [8, 9] },
  AR: { code: "54", trunk: "0", len: [10, 11] },
  AT: { code: "43", trunk: "0", len: [4, 13] },
  AU: { code: "61", trunk: "0", len: [9, 9] },
  BD: { code: "880", trunk: "0", len: [10, 10] },
  BE: { code: "32", trunk: "0", len: [8, 9] },
  BH: { code: "973", len: [8, 8] },
  BR: { code: "55", trunk: "0", len: [10, 11] },
  CA: { code: "1", trunk: "1", len: [10, 10] },
  CH: { code: "41", trunk: "0", len: [9, 9] },
  CL: { code: "56", len: [9, 9] },
  CN: { code: "86", trunk: "0", len: [10, 11] },
  CO: { code: "57", len: [10, 10] },
  DE: { code: "49", trunk: "0", len: [6, 13] },
  DK: { code: "45", len: [8, 8] },
  EG: { code: "20", trunk: "0", len: [9, 10] },
  ES: { code: "34", len: [9, 9] },
  FI: { code: "358", trunk: "0", len: [5, 12] },
  FR: { code: "33", trunk: "0", len: [9, 9] },
  GB: { code: "44", trunk: "0", len: [9, 10] },
  GH: { code: "233", trunk: "0", len: [9, 9] },
  GR: { code: "30", len: [10, 10] },
  HK: { code: "852", len: [8, 8] },
  ID: { code: "62", trunk: "0", len: [9, 12] },
  IE: { code: "353", trunk: "0", len: [7, 9] },
  IL: { code: "972", trunk: "0", len: [8, 9] },
  IN: { code: "91", trunk: "0", len: [10, 10] },
  IT: { code: "39", len: [6, 11] },
  JP: { code: "81", trunk: "0", len: [9, 10] },
  KE: { code: "254", trunk: "0", len: [9, 9] },
  KR: { code: "82", trunk: "0", len: [8, 10] },
  KW: { code: "965", len: [8, 8] },
  LK: { code: "94", trunk: "0", len: [9, 9] },
  MX: { code: "52", len: [10, 10] },
  MY: { code: "60", trunk: "0", len: [8, 10] },
  NG: { code: "234", trunk: "0", len: [8, 10] },
  NL: { code: "31", trunk: "0", len: [9, 9] },
  NO: { code: "47", len: [8, 8] },
  NP: { code: "977", trunk: "0", len: [8, 10] },
  NZ: { code: "64", trunk: "0", len: [8, 10] },
  OM: { code: "968", len: [8, 8] },
  PE: { code: "51", len: [8, 9] },
  PH: { code: "63", trunk: "0", len: [9, 10] },
  PK: { code: "92", trunk: "0", len: [9, 10] },
  PL: { code: "48", len: [9, 9] },
  PT: { code: "351", len: [9, 9] },
  QA: { code: "974", len: [8, 8] },
  RO: { code: "40", trunk: "0", len: [9, 9] },
  SA: { code: "966", trunk: "0", len: [8, 9] },
  SE: { code: "46", trunk: "0", len: [7, 9] },
  SG: { code: "65", len: [8, 8] },
  TH: { code: "66", trunk: "0", len: [8, 9] },
  TR: { code: "90", trunk: "0", len: [10, 10] },
  TW: { code: "886", trunk: "0", len: [8, 9] },
  UA: { code: "380", trunk: "0", len: [9, 9] },
  US: { code: "1", trunk: "1", len: [10, 10] },
  VN: { code: "84", trunk: "0", len: [9, 10] },
  ZA: { code: "27", trunk: "0", len: [9, 9] },
};

/** Where countries share a calling code, the one a number is said to be from. */
const SHARED_CODE_COUNTRY: Record<string, string> = { "1": "US" };

/** Calling codes we can map back to a country (longest code first, so "971" wins over "97"). */
const BY_CODE = Object.entries(COUNTRIES)
  .map(([iso, c]) => ({ iso, code: c.code }))
  .filter((v) => (SHARED_CODE_COUNTRY[v.code] ?? v.iso) === v.iso)
  .filter((v, i, a) => a.findIndex((w) => w.code === v.code) === i)
  .sort((a, b) => b.code.length - a.code.length);

export interface NormalizedPhone {
  /** E.164 without the plus sign, as the Cloud API's `to` and webhooks' `wa_id` use it. */
  waId: string;
  /** "+61412345678". */
  e164: string;
  /** ISO country of the number, when its calling code is one we know. */
  country: string | null;
}

/**
 * A phone number as a customer typed it into a checkout, as an international number, or null
 * when that can't be done with confidence: an international number with 8 to 15 digits, or a
 * local one whose country (the shipping or billing address's) we know the rules for.
 */
export function normalizePhone(raw: string | null | undefined, country?: string | null): NormalizedPhone | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || /[a-z]/i.test(trimmed.replace(/(ext|x)\.?\s*\d+$/i, ""))) return null;
  const noExt = trimmed.replace(/\s*(ext|x)\.?\s*\d+$/i, "");
  let digits = noExt.replace(/[^\d+]/g, "");
  let international = false;
  if (digits.startsWith("+")) {
    international = true;
    digits = digits.slice(1);
  } else if (digits.startsWith("00")) {
    international = true;
    digits = digits.slice(2);
  }
  if (digits.includes("+") || !/^\d+$/.test(digits)) return null;
  if (!international) {
    const c = country ? COUNTRIES[country.toUpperCase()] : undefined;
    if (!c) return null;
    const [min, max] = c.len ?? [6, 13];
    const fits = (n: string) => n.length >= min && n.length <= max;
    const strip = (prefix: string | undefined) => (prefix && digits.startsWith(prefix) && fits(digits.slice(prefix.length)) ? digits.slice(prefix.length) : null);
    // "0412 345 678" (trunk prefix), "61412345678" (country code typed without "+"), "412345678".
    // Where the country dials a trunk prefix, a local number typed without it is rarer than one
    // typed with the country code, so the code is tried first there; elsewhere (Italy, Spain),
    // the number as typed is.
    const national = c.trunk ? (strip(c.trunk) ?? strip(c.code) ?? (fits(digits) ? digits : null)) : ((fits(digits) ? digits : null) ?? strip(c.code));
    if (!national) return null;
    digits = c.code + national;
  }
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return null;
  return { waId: digits, e164: `+${digits}`, country: countryOfWaId(digits) };
}

/** The ISO country a number's calling code belongs to, when it is one we know. */
export function countryOfWaId(waId: string): string | null {
  const hit = BY_CODE.find((c) => waId.startsWith(c.code));
  return hit?.iso ?? null;
}

/** "+61 •••• •••• 678": enough for the merchant to tell numbers apart, nothing more. */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const hit = BY_CODE.find((c) => digits.startsWith(c.code));
  const cc = hit ? hit.code : digits.slice(0, Math.min(3, digits.length - 4));
  const rest = digits.slice(cc.length);
  const tail = rest.slice(-3);
  return `+${cc} ${"•".repeat(Math.max(2, rest.length - 3))} ${tail}`;
}

// ---------------------------------------------------------------------------
// Opt-out and opt-in keywords (an inbound WhatsApp message whose whole text is one of these)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "opt out", "stop promotions", "no more", "remove me"]);
const START_WORDS = new Set(["start", "subscribe", "optin", "opt in", "yes please", "unstop"]);

const keyword = (text: string) => text.trim().toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ");

/** "STOP": the customer wants no more messages from this business (marketing and order updates). */
export const isStopKeyword = (text: string | null | undefined) => !!text && STOP_WORDS.has(keyword(text));
/** "START": the customer asks to receive offers on WhatsApp. */
export const isStartKeyword = (text: string | null | undefined) => !!text && START_WORDS.has(keyword(text));
/** The quick-reply button marketing templates carry. Stops marketing only, not order updates. */
export const isStopPromotionsReply = (text: string | null | undefined) => !!text && keyword(text) === "stop promotions";

// ---------------------------------------------------------------------------
// What gets sent, and when
// ---------------------------------------------------------------------------

/** Where a template's variable takes its value from. All are computed on the server. */
export const PARAM_SOURCES = [
  "customer_name",
  "store_name",
  "order_number",
  "order_total",
  "delivery_address",
  "tracking_url",
  "tracking_token",
  "courier_name",
  "tracking_number",
  "carrier_tracking_url",
  "estimated_delivery",
  "review_url",
  "review_token",
  "checkout_url",
  "checkout_link_code",
  "cart_total",
  "refund_amount",
  "campaign_url",
  "campaign_link_code",
  "discount_code",
  "discount_percentage",
  "end_date",
  "occasion",
  "support_contact",
  "custom_text",
] as const;
export type ParamSource = (typeof PARAM_SOURCES)[number];

export const PARAM_LABEL: Record<ParamSource, string> = {
  customer_name: "Customer first name",
  store_name: "Store name",
  order_number: "Order number",
  order_total: "Order total",
  delivery_address: "Delivery address",
  tracking_url: "Order tracking link",
  tracking_token: "Tracking link code (for a URL button)",
  courier_name: "Courier",
  tracking_number: "Tracking number",
  carrier_tracking_url: "Courier's tracking link",
  estimated_delivery: "Estimated delivery",
  review_url: "Review link",
  review_token: "Review link code (for a URL button)",
  checkout_url: "Checkout link",
  checkout_link_code: "Checkout link code (for a URL button)",
  cart_total: "Cart value",
  refund_amount: "Refund amount",
  campaign_url: "Campaign link",
  campaign_link_code: "Campaign link code (for a URL button)",
  discount_code: "Discount code",
  discount_percentage: "Discount percentage",
  end_date: "Offer end date",
  occasion: "Occasion greeting",
  support_contact: "Support contact",
  custom_text: "Fixed text",
};

/** How a template's variables are filled: body {{1}}, {{2}}…, a text header, and a URL button's suffix. */
export const templateMappingSchema = z.object({
  body: z.array(z.enum(PARAM_SOURCES)).max(20).default([]),
  header: z.enum(PARAM_SOURCES).optional(),
  /** One entry per dynamic URL button, in button order. */
  buttons: z.array(z.enum(PARAM_SOURCES)).max(2).default([]),
  /** Values for `custom_text`, by position ("body.2", "header", "button.0"). */
  fixed: z.record(z.string().max(200)).default({}),
});
export type TemplateMapping = z.infer<typeof templateMappingSchema>;

export const NOTIFICATION_KINDS = [
  "order_confirmation",
  "payment_confirmed",
  "order_processing",
  "order_packed",
  "order_shipped",
  "out_for_delivery",
  "order_delivered",
  "delivery_failed",
  "order_cancelled",
  "refund_processed",
  "abandoned_cart_1",
  "abandoned_cart_2",
  "review_request",
  "review_reminder",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface KindInfo {
  kind: NotificationKind;
  label: string;
  /** When it goes out, in words. */
  when: string;
  group: "orders" | "delivery" | "carts" | "reviews";
  /** The library template that fits it. */
  libraryTemplate: string;
}

export const KIND_INFO: Record<NotificationKind, KindInfo> = {
  order_confirmation: { kind: "order_confirmation", label: "Order confirmed", when: "When Shopify reports a new order (never for abandoned checkouts or orders that fail at payment)", group: "orders", libraryTemplate: "insights_order_confirmation" },
  payment_confirmed: { kind: "payment_confirmed", label: "Payment confirmed", when: "When an order that wasn't paid at checkout (cash on delivery, bank transfer) is marked paid", group: "orders", libraryTemplate: "insights_payment_confirmed" },
  order_processing: { kind: "order_processing", label: "Order processing", when: "When you mark the order processing: add the processing tag in Shopify, or press the button in bizinsights", group: "orders", libraryTemplate: "insights_order_processing" },
  order_packed: { kind: "order_packed", label: "Order packed", when: "When you mark the order packed: add the packed tag in Shopify, or press the button in bizinsights", group: "orders", libraryTemplate: "insights_order_packed" },
  order_cancelled: { kind: "order_cancelled", label: "Order cancelled", when: "When the order is cancelled in Shopify", group: "orders", libraryTemplate: "insights_order_cancelled" },
  refund_processed: { kind: "refund_processed", label: "Refund processed", when: "When Shopify records a refund on the order", group: "orders", libraryTemplate: "insights_refund_processed" },
  order_shipped: { kind: "order_shipped", label: "Order shipped", when: "When the order is fulfilled in Shopify (with the courier and tracking number when there is one)", group: "delivery", libraryTemplate: "insights_order_shipped" },
  out_for_delivery: { kind: "out_for_delivery", label: "Out for delivery", when: "When the courier reports the parcel is out for delivery", group: "delivery", libraryTemplate: "insights_out_for_delivery" },
  order_delivered: { kind: "order_delivered", label: "Delivered", when: "Only when the courier (or you) confirms delivery: never guessed", group: "delivery", libraryTemplate: "insights_order_delivered" },
  delivery_failed: { kind: "delivery_failed", label: "Delivery attempt failed", when: "When the courier reports a failed delivery attempt", group: "delivery", libraryTemplate: "insights_delivery_failed" },
  abandoned_cart_1: { kind: "abandoned_cart_1", label: "First cart reminder", when: "After a checkout with a phone number and WhatsApp marketing consent is left unfinished", group: "carts", libraryTemplate: "insights_cart_reminder" },
  abandoned_cart_2: { kind: "abandoned_cart_2", label: "Second cart reminder (optional)", when: "If the checkout is still unfinished after the first reminder", group: "carts", libraryTemplate: "insights_cart_reminder" },
  review_request: { kind: "review_request", label: "Review request", when: "A few days after a confirmed delivery", group: "reviews", libraryTemplate: "insights_review_request" },
  review_reminder: { kind: "review_reminder", label: "Review reminder (optional)", when: "Once, if no review came in after the request", group: "reviews", libraryTemplate: "insights_review_request" },
};

export type KindGroup = KindInfo["group"];

/** The notification kinds of one group (a page of the WhatsApp area), in NOTIFICATION_KINDS order. */
export const kindsOf = (group: KindGroup): NotificationKind[] => NOTIFICATION_KINDS.filter((k) => KIND_INFO[k].group === group);

/** The message kinds the message history shows for one filter (?group=): a notification group, or another sender. */
export function messageKinds(group: string): string[] | null {
  if (group === "orders" || group === "delivery" || group === "carts" || group === "reviews") return kindsOf(group);
  return group === "campaign" || group === "automation" || group === "test" ? [group] : null;
}

/**
 * How far an order has got with its parcel. Webhooks arrive late, twice, and out of order:
 * a notification only goes out for a status further along than the order's furthest one.
 * Failed attempts sit beside the line (a parcel can fail and then be delivered).
 */
export const SHIPMENT_RANK = { none: 0, shipped: 1, in_transit: 2, out_for_delivery: 3, delivered: 4 } as const;
export type ShipmentStage = keyof typeof SHIPMENT_RANK;

/** Shopify's shipment status (REST `shipment_status`, fulfillment event `status`, GraphQL `displayStatus`) as our stage. */
export function shipmentStage(status: string | null | undefined): ShipmentStage | "failed" | null {
  switch ((status ?? "").toLowerCase()) {
    case "in_transit":
    case "carrier_picked_up":
    case "picked_up":
      return "in_transit";
    case "out_for_delivery":
      return "out_for_delivery";
    case "delivered":
      return "delivered";
    case "attempted_delivery":
    case "failure":
    case "not_delivered":
      return "failed";
    case "confirmed":
    case "label_printed":
    case "label_purchased":
    case "ready_for_pickup":
    case "fulfilled":
    case "marked_as_fulfilled":
    case "submitted":
      return "shipped";
    default:
      return null;
  }
}

/** The order-level status shown on the tracking page. */
export const TRACKING_STATUSES = [
  "placed",
  "paid",
  "processing",
  "packed",
  "shipped",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delivery_failed",
  "cancelled",
  "refunded",
] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

// ---------------------------------------------------------------------------
// Template library: what bizinsights can create in the merchant's WhatsApp account for review
// ---------------------------------------------------------------------------

export interface LibraryTemplate {
  name: string;
  category: "UTILITY" | "MARKETING";
  label: string;
  body: string;
  /** Example values for the body variables, in order (Meta reviews templates with them). */
  examples: string[];
  /** A URL button whose link ends in {{1}}; `path` is appended to the app's (or API's) URL. */
  urlButton?: { text: string; base: "app" | "api"; path: string; example: string };
  /** Marketing templates offer a one-tap way out. */
  stopButton?: boolean;
  mapping: TemplateMapping;
  footer?: string;
}

const m = (body: ParamSource[], buttons: ParamSource[] = []): TemplateMapping => ({ body, buttons, fixed: {} });

export const TEMPLATE_LIBRARY: LibraryTemplate[] = [
  {
    name: "insights_order_confirmation",
    category: "UTILITY",
    label: "Order confirmation",
    body: "Hi {{1}}! 👋\nThank you for shopping with {{2}}.\nYour order {{3}} has been successfully placed!\nOrder total: {{4}}\nDelivery address: {{5}}\n\nWe'll notify you when your order is shipped and delivered. You can track it any time with the button below.\nThank you for choosing us!",
    examples: ["Asha", "Green Leaf Store", "#1042", "₹1,499.00", "12 MG Road, Kochi 682016"],
    urlButton: { text: "Track your order", base: "app", path: "/track?t=", example: "Xk3v9QmZr2" },
    mapping: m(["customer_name", "store_name", "order_number", "order_total", "delivery_address"], ["tracking_token"]),
  },
  {
    name: "insights_payment_confirmed",
    category: "UTILITY",
    label: "Payment confirmed",
    body: "Hi {{1}}, we've received the payment for your order {{2}} from {{3}}. Thank you!\nWe'll let you know as soon as it ships.",
    examples: ["Asha", "#1042", "Green Leaf Store"],
    urlButton: { text: "Track your order", base: "app", path: "/track?t=", example: "Xk3v9QmZr2" },
    mapping: m(["customer_name", "order_number", "store_name"], ["tracking_token"]),
  },
  {
    name: "insights_order_processing",
    category: "UTILITY",
    label: "Order processing",
    body: "Hi {{1}}, your order {{2}} is now being processed by {{3}}. We'll update you when it's packed and on its way.",
    examples: ["Asha", "#1042", "Green Leaf Store"],
    urlButton: { text: "Track your order", base: "app", path: "/track?t=", example: "Xk3v9QmZr2" },
    mapping: m(["customer_name", "order_number", "store_name"], ["tracking_token"]),
  },
  {
    name: "insights_order_packed",
    category: "UTILITY",
    label: "Order packed",
    body: "Hi {{1}}, your order {{2}} has been packed and will be handed to the courier soon. We'll send the tracking details when it ships.",
    examples: ["Asha", "#1042"],
    urlButton: { text: "Track your order", base: "app", path: "/track?t=", example: "Xk3v9QmZr2" },
    mapping: m(["customer_name", "order_number"], ["tracking_token"]),
  },
  {
    name: "insights_order_shipped",
    category: "UTILITY",
    label: "Order shipped",
    body: "Good news, {{1}}! 📦\nYour order {{2}} has been shipped.\nCourier: {{3}}\nTracking number: {{4}}\n\nWe'll keep you updated!",
    examples: ["Asha", "#1042", "Blue Dart", "BD123456789IN"],
    urlButton: { text: "Track your package", base: "app", path: "/track?t=", example: "Xk3v9QmZr2" },
    mapping: m(["customer_name", "order_number", "courier_name", "tracking_number"], ["tracking_token"]),
  },
  {
    name: "insights_out_for_delivery",
    category: "UTILITY",
    label: "Out for delivery",
    body: "Hi {{1}}, your order {{2}} is out for delivery today with {{3}}. Please keep your phone nearby.",
    examples: ["Asha", "#1042", "Blue Dart"],
    urlButton: { text: "Track your package", base: "app", path: "/track?t=", example: "Xk3v9QmZr2" },
    mapping: m(["customer_name", "order_number", "courier_name"], ["tracking_token"]),
  },
  {
    name: "insights_order_delivered",
    category: "UTILITY",
    label: "Delivered",
    body: "Hi {{1}}! 🎉\nYour order {{2}} has been delivered successfully.\nWe hope you enjoy your purchase!\nPlease share your experience with us using the button below.",
    examples: ["Asha", "#1042"],
    urlButton: { text: "Share your experience", base: "app", path: "/review?t=", example: "Rv8pQ2nL4w" },
    mapping: m(["customer_name", "order_number"], ["review_token"]),
  },
  {
    name: "insights_delivery_failed",
    category: "UTILITY",
    label: "Delivery attempt failed",
    body: "Hi {{1}}, {{2}} couldn't deliver your order {{3}} today. They will usually try again; you can check the latest status with the button below or reply here for help.",
    examples: ["Asha", "Blue Dart", "#1042"],
    urlButton: { text: "Track your package", base: "app", path: "/track?t=", example: "Xk3v9QmZr2" },
    mapping: m(["customer_name", "courier_name", "order_number"], ["tracking_token"]),
  },
  {
    name: "insights_order_cancelled",
    category: "UTILITY",
    label: "Order cancelled",
    body: "Hi {{1}}, your order {{2}} from {{3}} has been cancelled. If you've already paid, any refund will follow the store's refund policy. Reply here if you have questions.",
    examples: ["Asha", "#1042", "Green Leaf Store"],
    mapping: m(["customer_name", "order_number", "store_name"]),
  },
  {
    name: "insights_refund_processed",
    category: "UTILITY",
    label: "Refund processed",
    body: "Hi {{1}}, a refund of {{2}} for your order {{3}} has been processed. Depending on your bank it can take a few days to appear.",
    examples: ["Asha", "₹499.00", "#1042"],
    mapping: m(["customer_name", "refund_amount", "order_number"]),
  },
  {
    name: "insights_cart_reminder",
    category: "MARKETING",
    label: "Abandoned cart reminder",
    body: "Hi {{1}}! 👋\nYou left a few items in your cart at {{2}}.\nYour selected products are still waiting for you!\n\nNeed any help? Reply to this message and our team will assist you.",
    examples: ["Asha", "Green Leaf Store"],
    urlButton: { text: "Continue shopping", base: "api", path: "/r/", example: "c7Hk2pQx9a" },
    stopButton: true,
    mapping: m(["customer_name", "store_name"], ["checkout_link_code"]),
  },
  {
    name: "insights_review_request",
    category: "UTILITY",
    label: "Review request",
    body: "Hi {{1}}! ❤️\nYour order {{2}} has been delivered.\nWe'd love to know how your experience was!\nPlease rate your purchase and share your feedback using the button below.\nThank you for shopping with {{3}}.",
    examples: ["Asha", "#1042", "Green Leaf Store"],
    urlButton: { text: "Leave a review", base: "app", path: "/review?t=", example: "Rv8pQ2nL4w" },
    mapping: m(["customer_name", "order_number", "store_name"], ["review_token"]),
  },
  {
    name: "insights_seasonal_offer",
    category: "MARKETING",
    label: "Seasonal offer",
    body: "🌼 {{1}} from {{2}}!\nCelebrate the season with special offers on selected products.\nEnjoy {{3}}% off eligible items.\nOffer valid until {{4}}. Terms apply.",
    examples: ["Happy Onam", "Green Leaf Store", "20", "15 September"],
    urlButton: { text: "Explore the collection", base: "api", path: "/r/", example: "c7Hk2pQx9a" },
    stopButton: true,
    mapping: m(["occasion", "store_name", "discount_percentage", "end_date"], ["campaign_link_code"]),
  },
];

export const libraryTemplate = (name: string) => TEMPLATE_LIBRARY.find((t) => t.name === name) ?? null;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const kindSettingSchema = z.object({
  enabled: z.boolean().default(false),
  templateName: z.string().max(512).nullable().default(null),
  language: z.string().max(15).default("en"),
  mapping: templateMappingSchema.default({}),
});
export type KindSetting = z.infer<typeof kindSettingSchema>;

/**
 * Whom order updates (utility templates) may go to. WhatsApp's policy needs an opt-in before a
 * business messages someone; Shopify's checkout doesn't ask for one by itself, so the merchant
 * says how their customers agree, and nothing goes out until they have.
 *  - none: not chosen yet (nothing is sent)
 *  - checkout_notice: the merchant's checkout tells customers they'll get order updates on WhatsApp
 *  - cart_attribute: only orders that carry the `whatsapp_opt_in` cart attribute (a checkbox on the store)
 *  - sms_consent: only customers who accepted Shopify's text-message marketing
 */
export const TRANSACTIONAL_BASES = ["none", "checkout_notice", "cart_attribute", "sms_consent"] as const;
export type TransactionalBasis = (typeof TRANSACTIONAL_BASES)[number];

const hour = z.number().int().min(0).max(23);

export const whatsappConfigSchema = z.object({
  notifications: z.record(z.enum(NOTIFICATION_KINDS), kindSettingSchema).default({}),
  transactionalBasis: z.enum(TRANSACTIONAL_BASES).default("none"),
  /** Count Shopify's SMS marketing consent as consent to WhatsApp marketing (only if the store's wording covers WhatsApp). */
  smsConsentCountsForMarketing: z.boolean().default(false),
  /** Marketing messages (campaigns, cart reminders) only go out between these hours, store time. */
  sendWindowStart: hour.default(9),
  sendWindowEnd: hour.default(21),
  /** At most this many marketing messages per customer per 7 days. */
  marketingPerWeek: z.number().int().min(1).max(14).default(2),
  cartFirstDelayMinutes: z.number().int().min(15).max(2880).default(60),
  cartSecondDelayMinutes: z.number().int().min(60).max(10080).default(1440),
  reviewDelayDays: z.number().int().min(0).max(60).default(3),
  reviewReminderDays: z.number().int().min(1).max(30).default(4),
  reviewAutoPublish: z.boolean().default(false),
  processingTag: z.string().trim().min(1).max(40).default("processing"),
  packedTag: z.string().trim().min(1).max(40).default("packed"),
  supportPhone: z.string().trim().max(40).default(""),
  supportEmail: z.string().trim().max(200).default(""),
  /** Days after a campaign message during which the customer's order counts as a conversion. */
  attributionDays: z.number().int().min(1).max(14).default(3),
});
export type WhatsappConfig = z.infer<typeof whatsappConfigSchema>;

/** A kind's setting with defaults filled in (library template and its mapping). */
export function kindSetting(cfg: WhatsappConfig, kind: NotificationKind): KindSetting {
  const s = cfg.notifications[kind];
  if (s) return s;
  const lib = libraryTemplate(KIND_INFO[kind].libraryTemplate)!;
  return { enabled: false, templateName: null, language: "en", mapping: lib.mapping };
}

// ---------------------------------------------------------------------------
// Template variables → Cloud API components
// ---------------------------------------------------------------------------

/** What a stored template looks like (the components Meta returns). */
export interface TemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type: string; text?: string; url?: string }>;
}

/** Number of {{n}} variables in a text. */
export function countVariables(text: string | undefined): number {
  if (!text) return 0;
  const nums = [...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((x) => Number(x[1]));
  return nums.length ? Math.max(...nums) : 0;
}

export interface TemplateShape {
  bodyVars: number;
  headerFormat: "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
  headerVars: number;
  /** Indexes (in the buttons list) of URL buttons whose link has a variable. */
  dynamicUrlButtons: number[];
}

export function templateShape(components: TemplateComponent[]): TemplateShape {
  const body = components.find((c) => c.type.toUpperCase() === "BODY");
  const header = components.find((c) => c.type.toUpperCase() === "HEADER");
  const buttons = components.find((c) => c.type.toUpperCase() === "BUTTONS")?.buttons ?? [];
  const format = (header?.format?.toUpperCase() ?? "NONE") as TemplateShape["headerFormat"];
  return {
    bodyVars: countVariables(body?.text),
    headerFormat: header ? format : "NONE",
    headerVars: format === "TEXT" ? countVariables(header?.text) : 0,
    dynamicUrlButtons: buttons.flatMap((b, i) => (b.type.toUpperCase() === "URL" && countVariables(b.url) > 0 ? [i] : [])),
  };
}

/** Meta refuses parameters with newlines, tabs or more than four spaces in a row, and empty ones. */
export function cleanParam(value: string | null | undefined, max = 600): string {
  const v = (value ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
  return (v || "-").slice(0, max);
}

export interface SendComponents {
  components: Array<Record<string, unknown>>;
}

/**
 * Turn resolved values into the `template.components` of a Cloud API send. Missing body values
 * are an error (Meta would reject the send); `values` is keyed by ParamSource.
 */
export function buildComponents(
  shape: TemplateShape,
  mapping: TemplateMapping,
  values: Partial<Record<ParamSource, string | null>>,
  media?: { link: string } | null,
): SendComponents {
  const resolve = (src: ParamSource | undefined, pos: string) => {
    if (!src) return null;
    if (src === "custom_text") return mapping.fixed[pos] ?? null;
    return values[src] ?? null;
  };
  const components: Array<Record<string, unknown>> = [];
  if (shape.headerFormat === "TEXT" && shape.headerVars > 0) {
    components.push({ type: "header", parameters: [{ type: "text", text: cleanParam(resolve(mapping.header, "header"), 60) }] });
  } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(shape.headerFormat)) {
    if (!media?.link) throw new Error(`This template needs a ${shape.headerFormat.toLowerCase()} for its header`);
    const k = shape.headerFormat.toLowerCase();
    components.push({ type: "header", parameters: [{ type: k, [k]: { link: media.link } }] });
  }
  if (shape.bodyVars > 0) {
    if (mapping.body.length < shape.bodyVars) throw new Error(`The template has ${shape.bodyVars} variables but only ${mapping.body.length} are mapped`);
    components.push({
      type: "body",
      parameters: mapping.body.slice(0, shape.bodyVars).map((src, i) => ({ type: "text", text: cleanParam(resolve(src, `body.${i + 1}`)) })),
    });
  }
  shape.dynamicUrlButtons.forEach((index, n) => {
    const src = mapping.buttons[n];
    const v = resolve(src, `button.${n}`);
    if (!v) throw new Error("The template's link button has nothing to link to");
    components.push({ type: "button", sub_type: "url", index: String(index), parameters: [{ type: "text", text: cleanParam(v, 2000) }] });
  });
  return { components };
}

/** Fill a template's text with values, for previews in the dashboard. */
export function previewText(text: string, values: string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_x, n: string) => values[Number(n) - 1] ?? `{{${n}}}`);
}

// ---------------------------------------------------------------------------
// Cloud API errors: what to do about each
// ---------------------------------------------------------------------------

export type ErrorAction =
  /** Try again later (rate limits, Meta outages). */
  | "retry"
  /** Access ended: the connection needs reconnecting; nothing will send until then. */
  | "reconnect"
  /** The customer has stopped marketing messages from this business. */
  | "marketing_opt_out"
  /** This message can't be sent as it is (bad template, number not on WhatsApp, outside the window). */
  | "fail";

/**
 * Codes from https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes.
 * Unknown codes fail the message rather than retrying it forever; a 5xx without a code retries.
 */
export function classifyGraphError(code: number | null | undefined, httpStatus: number): ErrorAction {
  if (code === 190 || code === 102 || code === 10 || code === 200 || code === 3 || code === 33 || code === 100 && httpStatus === 401) return "reconnect";
  if (code === 131050 || code === 498) return "marketing_opt_out";
  // Throttling, per-pair limits, Meta busy, temporary errors, spam-rate limit.
  if ([4, 80007, 130429, 131016, 131048, 131056, 131000, 133004, 2, 1].includes(code ?? -1)) return "retry";
  // The healthy-ecosystem limit on marketing: Meta held it back; retrying the same day won't help much,
  // but a later attempt can succeed.
  if (code === 131049) return "retry";
  if (code === null || code === undefined) return httpStatus >= 500 || httpStatus === 429 ? "retry" : "fail";
  return "fail";
}

/** Plain words for the failures a merchant is most likely to see. */
export function errorExplanation(code: string | number | null | undefined, fallback?: string | null): string {
  switch (Number(code)) {
    case 131026:
      return "The number isn't on WhatsApp, or couldn't receive the message.";
    case 131047:
      return "More than 24 hours since the customer last wrote: only an approved template can be sent.";
    case 131049:
      return "Meta held back this marketing message to protect the customer's experience (too many marketing messages recently).";
    case 131050:
    case 498:
      return "The customer has stopped marketing messages from your business.";
    case 131051:
      return "WhatsApp doesn't support this message type.";
    case 131056:
      return "Too many messages to this customer in a short time; it will be retried.";
    case 132000:
      return "The template's variables don't match what was sent.";
    case 132001:
      return "The template doesn't exist in this language, or isn't approved.";
    case 132007:
      return "The template's content breaks WhatsApp's policy.";
    case 132015:
    case 132016:
      return "The template is paused or disabled because of low quality.";
    case 133010:
      return "Your phone number isn't registered with the Cloud API yet.";
    case 130429:
      return "WhatsApp's rate limit was reached; it will be retried.";
    case 190:
      return "Meta no longer accepts bizinsights' access: reconnect WhatsApp.";
    case 368:
      return "Your WhatsApp account is temporarily blocked for policy violations.";
    default:
      return fallback || "WhatsApp couldn't send this message.";
  }
}

/** Retry waits for a message that failed with "retry": 30 s, 2 min, 10 min, 30 min, 2 h. */
export const WA_RETRY_DELAYS_S = [30, 120, 600, 1800, 7200];
export const WA_MAX_ATTEMPTS = WA_RETRY_DELAYS_S.length + 1;

// ---------------------------------------------------------------------------
// Sending hours (store time)
// ---------------------------------------------------------------------------

function zonedHour(at: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { hour: get("hour") % 24, minute: get("minute") };
}

/** Whether `at` falls inside [start, end) in the store's time zone (a window may wrap midnight). */
export function inSendWindow(at: Date, timeZone: string, start: number, end: number): boolean {
  if (start === end) return true;
  const { hour } = zonedHour(at, timeZone);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** The earliest moment at or after `at` that is inside the window (to the minute). */
export function nextSendTime(at: Date, timeZone: string, start: number, end: number): Date {
  if (inSendWindow(at, timeZone, start, end)) return at;
  const { hour, minute } = zonedHour(at, timeZone);
  let hoursAhead = (start - hour + 24) % 24;
  if (hoursAhead === 0) hoursAhead = 24;
  const t = new Date(at.getTime() + hoursAhead * 3600_000 - minute * 60_000);
  t.setUTCSeconds(0, 0);
  // Time-zone transitions can land an hour off; step forward until inside.
  for (let i = 0; i < 3 && !inSendWindow(t, timeZone, start, end); i++) t.setTime(t.getTime() + 3600_000);
  return t;
}

// ---------------------------------------------------------------------------
// Seasonal campaigns
// ---------------------------------------------------------------------------

export const OCCASIONS = [
  { id: "onam", label: "Onam", greeting: "Happy Onam" },
  { id: "vishu", label: "Vishu", greeting: "Happy Vishu" },
  { id: "christmas", label: "Christmas", greeting: "Merry Christmas" },
  { id: "new_year", label: "New Year", greeting: "Happy New Year" },
  { id: "eid", label: "Eid", greeting: "Eid Mubarak" },
  { id: "diwali", label: "Diwali", greeting: "Happy Diwali" },
  { id: "black_friday", label: "Black Friday", greeting: "Black Friday deals" },
  { id: "cyber_monday", label: "Cyber Monday", greeting: "Cyber Monday deals" },
  { id: "anniversary", label: "Store anniversary", greeting: "It's our anniversary" },
  { id: "product_launch", label: "Product launch", greeting: "Something new" },
  { id: "clearance", label: "Clearance sale", greeting: "Clearance sale" },
  { id: "custom", label: "Custom promotion", greeting: "Special offers" },
] as const;

export const audienceSchema = z.object({
  /** Every customer below must also have opted in to WhatsApp marketing; this narrows it further. */
  segment: z.enum(["all_opted_in", "recent_buyers", "lapsed_buyers", "repeat_buyers", "high_spenders"]).default("all_opted_in"),
  /** recent_buyers: bought within; lapsed_buyers: no order within. */
  days: z.number().int().min(1).max(730).default(90),
  /** high_spenders: total of their orders (store currency) at least. */
  minSpend: z.number().min(0).max(10_000_000).default(0),
  /** ISO countries of the customers' numbers; empty = anywhere. */
  countries: z.array(z.string().length(2).toUpperCase()).max(50).default([]),
});
export type Audience = z.infer<typeof audienceSchema>;

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "paused", "completed", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type CampaignAction = "pause" | "resume" | "cancel";

const CAMPAIGN_ACTION_FROM: Record<CampaignAction, readonly string[]> = {
  pause: ["scheduled", "sending"],
  resume: ["paused"],
  cancel: ["draft", "scheduled", "sending", "paused"],
};

/** Whether a campaign in this status can be paused, resumed or cancelled. */
export const campaignCan = (status: string, action: CampaignAction) => CAMPAIGN_ACTION_FROM[action].includes(status);

/** The status a campaign moves to: resuming one that never started schedules it again. */
export function campaignStatusAfter(action: CampaignAction, started: boolean): CampaignStatus {
  if (action === "pause") return "paused";
  if (action === "resume") return started ? "sending" : "scheduled";
  return "cancelled";
}

/** A campaign that hasn't started can still be edited; editing a scheduled one takes it back to draft. */
export const campaignEditable = (status: string) => status === "draft" || status === "scheduled";

// ---------------------------------------------------------------------------
// Automation rules: trigger → conditions → action
// ---------------------------------------------------------------------------

export const AUTOMATION_TRIGGERS = [
  "order_created",
  "payment_confirmed",
  "fulfillment_created",
  "tracking_updated",
  "order_delivered",
  "checkout_abandoned",
  "cart_recovered",
  "review_request_due",
  "customer_opted_in",
  "refund_created",
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  order_created: "Order created",
  payment_confirmed: "Payment confirmed",
  fulfillment_created: "Fulfillment created",
  tracking_updated: "Shipment tracking updated",
  order_delivered: "Order delivered",
  checkout_abandoned: "Checkout abandoned",
  cart_recovered: "Cart recovered",
  review_request_due: "Review request due",
  customer_opted_in: "Customer opted in",
  refund_created: "Refund created",
};

export const CONDITION_FIELDS = ["order_value", "product", "order_status", "customer_segment", "country", "marketing_consent", "previous_message_status"] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export const conditionSchema = z.object({
  field: z.enum(CONDITION_FIELDS),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "contains"]),
  value: z.union([z.string().max(200), z.number(), z.array(z.string().max(200)).max(50), z.boolean()]),
});
export type Condition = z.infer<typeof conditionSchema>;

export const automationActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send_template"), templateName: z.string().min(1).max(512), language: z.string().max(15).default("en"), mapping: templateMappingSchema.default({}) }),
  z.object({
    type: z.literal("schedule_reminder"),
    templateName: z.string().min(1).max(512),
    language: z.string().max(15).default("en"),
    mapping: templateMappingSchema.default({}),
    delayMinutes: z.number().int().min(5).max(43_200),
  }),
  z.object({ type: z.literal("cancel_pending"), kinds: z.array(z.enum([...NOTIFICATION_KINDS, "automation"] as const)).min(1).max(20) }),
  z.object({ type: z.literal("internal_notification"), message: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal("record_event"), label: z.string().trim().min(1).max(100) }),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;

/** What a rule's conditions are evaluated against. Missing facts make a condition false. */
export interface AutomationFacts {
  orderValue?: number | null;
  productIds?: string[];
  productTitles?: string[];
  orderStatus?: string | null;
  /** "new" (first order with this store) | "returning" | "unknown" */
  customerSegment?: "new" | "returning" | "unknown";
  country?: string | null;
  marketingConsent?: boolean;
  /** Status of the last WhatsApp message to this customer about this order/checkout: none | scheduled | sent | delivered | read | failed | cancelled | skipped. */
  previousMessageStatus?: string;
}

function compare(actual: unknown, op: Condition["op"], expected: Condition["value"]): boolean {
  const list = Array.isArray(expected) ? expected.map((v) => String(v).toLowerCase()) : [String(expected).toLowerCase()];
  if (Array.isArray(actual)) {
    const have = actual.map((a) => String(a).toLowerCase());
    if (op === "in" || op === "contains" || op === "eq") return list.some((v) => have.some((h) => (op === "contains" ? h.includes(v) : h === v)));
    if (op === "not_in" || op === "neq") return !list.some((v) => have.includes(v));
    return false;
  }
  if (actual === undefined || actual === null) return false;
  if (typeof actual === "number") {
    const n = Number(Array.isArray(expected) ? expected[0] : expected);
    if (Number.isNaN(n)) return false;
    switch (op) {
      case "gt":
        return actual > n;
      case "gte":
        return actual >= n;
      case "lt":
        return actual < n;
      case "lte":
        return actual <= n;
      case "eq":
        return actual === n;
      case "neq":
        return actual !== n;
      default:
        return false;
    }
  }
  const a = String(actual).toLowerCase();
  switch (op) {
    case "eq":
      return a === list[0];
    case "neq":
      return a !== list[0];
    case "in":
      return list.includes(a);
    case "not_in":
      return !list.includes(a);
    case "contains":
      return list.some((v) => a.includes(v));
    default:
      return false;
  }
}

/** Every condition must hold (AND). Returns each one's result too, for "Test" in the dashboard. */
export function evaluateConditions(conditions: Condition[], facts: AutomationFacts): { pass: boolean; results: Array<{ condition: Condition; pass: boolean }> } {
  const results = conditions.map((c) => {
    let actual: unknown;
    switch (c.field) {
      case "order_value":
        actual = facts.orderValue;
        break;
      case "product":
        actual = [...(facts.productIds ?? []), ...(facts.productTitles ?? [])];
        break;
      case "order_status":
        actual = facts.orderStatus;
        break;
      case "customer_segment":
        actual = facts.customerSegment;
        break;
      case "country":
        actual = facts.country;
        break;
      case "marketing_consent":
        actual = facts.marketingConsent === undefined ? undefined : facts.marketingConsent ? "true" : "false";
        break;
      case "previous_message_status":
        actual = facts.previousMessageStatus ?? "none";
        break;
    }
    return { condition: c, pass: compare(actual, c.op, typeof c.value === "boolean" ? String(c.value) : c.value) };
  });
  return { pass: results.every((r) => r.pass), results };
}

export interface RuleLike {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: Condition[];
  action: AutomationAction;
}

export interface RuleConflict {
  /** "block": the rules would undo each other, so the rule can't be enabled. "warn": worth knowing. */
  severity: "block" | "warn";
  message: string;
}

/**
 * Problems between enabled rules on the same trigger: one cancelling what the other sends (they
 * would undo each other: refused), or both sending the same template (the customer still gets it
 * once, from whichever rule runs first, but the merchant should know).
 */
export function ruleConflicts(candidate: RuleLike, others: RuleLike[]): RuleConflict[] {
  if (!candidate.enabled) return [];
  const out: RuleConflict[] = [];
  const sends = (x: AutomationAction) => (x.type === "send_template" || x.type === "schedule_reminder" ? x.templateName : null);
  for (const o of others) {
    if (!o.enabled || o.id === candidate.id || o.trigger !== candidate.trigger) continue;
    const a = candidate.action;
    const b = o.action;
    if (sends(a) && sends(a) === sends(b)) {
      out.push({ severity: "warn", message: `"${o.name}" also sends ${sends(a)} on this trigger. A customer gets it once, from whichever rule runs first.` });
    }
    if ((a.type === "cancel_pending" && sends(b) && a.kinds.includes("automation")) || (b.type === "cancel_pending" && sends(a) && b.kinds.includes("automation"))) {
      out.push({ severity: "block", message: `"${o.name}" cancels what this rule sends on the same trigger, so they would undo each other.` });
    }
  }
  return out;
}

/** Why a message was skipped, cancelled or is waiting, in the merchant's words. */
export const REASON_LABEL: Record<string, string> = {
  no_phone: "No WhatsApp number for this customer. On live stores Shopify only shares phone numbers with apps approved for protected customer data.",
  opted_out: "The customer replied STOP.",
  marketing_stopped: "The customer stopped marketing messages from your business.",
  no_marketing_consent: "The customer hasn't agreed to WhatsApp marketing.",
  no_opt_in: "The customer didn't opt in to WhatsApp updates.",
  consent_basis_not_set: "Choose how customers agree to order updates (WhatsApp → Settings) before any are sent.",
  checkout_completed: "The customer finished their checkout.",
  first_reminder_not_sent: "The first reminder wasn't sent, so the second isn't either.",
  no_checkout_link: "Shopify didn't provide a link back to this checkout.",
  already_reviewed: "The customer has already left a review.",
  request_not_sent: "The review request itself wasn't sent.",
  order_cancelled: "The order was cancelled.",
  campaign_cancelled: "The campaign was cancelled.",
  campaign_ended: "The campaign's end date passed.",
  campaign_paused: "Waiting: the campaign is paused.",
  whatsapp_off: "WhatsApp is turned off for this store.",
  whatsapp_not_connected: "WhatsApp wasn't connected for 48 hours, so it was cancelled.",
  waiting_for_connection: "Waiting for WhatsApp to be connected (or reconnected).",
  whatsapp_disconnected: "WhatsApp was disconnected.",
  template_missing: "The template isn't in your WhatsApp account any more.",
  template_not_approved: "The template isn't approved by Meta.",
  template_pending: "Waiting for Meta to approve the template.",
  no_template: "No template was chosen.",
  frequency_cap: "The customer already got the most marketing messages allowed this week.",
  outside_send_window: "Waiting for your sending hours.",
  messaging_limit: "Waiting: your number reached its daily limit of new conversations.",
  pacing: "Waiting a moment to keep under WhatsApp's sending rate.",
  retrying: "WhatsApp asked us to try again later; it will be retried.",
  retries_exhausted: "WhatsApp kept refusing it, so we stopped retrying.",
  send_interrupted: "Sending was interrupted; it may or may not have arrived.",
  cancelled_by_merchant: "Cancelled from the dashboard.",
  rule_deleted: "The automation that scheduled it was deleted.",
  nothing_to_send: "Its details had already been cleared.",
};

export function reasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason.startsWith("template_mismatch")) return `The template doesn't match what was sent${reason.includes(":") ? ` (${reason.split(":").slice(1).join(":").trim()})` : ""}.`;
  if (reason.startsWith("rule:")) return `Cancelled by the automation "${reason.slice(5)}".`;
  return REASON_LABEL[reason] ?? reason.replace(/_/g, " ");
}

/** Message statuses, in the order a message goes through them. */
export const MESSAGE_STATUSES = ["scheduled", "sending", "sent", "delivered", "read", "failed", "cancelled", "skipped"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Delivery callbacks only move a message forward (a late "sent" never undoes "read"). */
export const STATUS_RANK: Record<string, number> = { scheduled: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

/** Reasons a merchant may remove a review for. "It's negative" is deliberately not one of them. */
export const MODERATION_REASONS = ["spam", "abusive", "personal_information", "off_topic", "not_a_customer_experience"] as const;
export type ModerationReason = (typeof MODERATION_REASONS)[number];
export const MODERATION_LABEL: Record<ModerationReason, string> = {
  spam: "Spam or advertising",
  abusive: "Abusive, hateful or threatening",
  personal_information: "Contains someone's personal information",
  off_topic: "Not about the product or order",
  not_a_customer_experience: "Not a genuine customer experience",
};
